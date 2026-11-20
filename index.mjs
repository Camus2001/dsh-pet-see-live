/**
 * dsh-pet-see-live — 让 dsh-pet 实时"看见"屏幕并点评。
 *
 * 它复用 dsh-see-now 的采集/拼图库（本地抓屏 + 变化打分 + 拼图，零 token），
 * 把拼好的图 POST 到 dsh-pet 自带的 /chat 接口，pet 就会用气泡 + 语音点评。
 *
 * 生命周期：
 *   - 随 dsh 加载：apply(ctx) 启动轮询
 *   - 随 dsh 卸载：dispose() 清理 ffmpeg / 定时器 / 在飞请求
 *   - pet 开着 → 采集 + 点评；pet 关闭 → 自动停采集（插件继续待命，pet 再开自动恢复）
 *
 * 速率保护：calm 出图 + 最小间隔 45s + 串行单次在飞 + 队列只留最新 + 429 退避。
 *
 * 跨平台：Windows / macOS / Linux。不依赖 PowerShell、curl 等外部命令。
 */
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ---- 路径：全部从 DSH_HOME / home 动态解析，无硬编码用户名 ----
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
const PET_DIR = join(dshHome(), 'dsh-pet');
const PET_LOG = join(PET_DIR, 'logs.txt');
const WATCH_LOG = join(PET_DIR, 'screen-watch.log');
const SELF_LOG = join(PET_DIR, 'see-live-plugin.log');

// ---- 可调参数（环境变量覆盖）----
const W = 798, H = 450, FPS = 12;             // low 档，对齐 42px patch，省 token
const MIN_GAP_MS = num('PET_SEE_MIN_GAP_MS', 45_000);
const POST_TIMEOUT_MS = num('PET_SEE_POST_TIMEOUT_MS', 120_000);
const BACKOFF_BASE_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
const PET_POLL_MS = 2000;
const TICK_MS = 1000;
const PROMPT = process.env.PET_SEE_PROMPT ||
  '看一眼我现在的屏幕，用简短一句话吐槽或评价，不超过20字。';

function num(k, d) {
  const v = process.env[k];
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(SELF_LOG, s, 'utf8'); } catch { /* ignore */ }
}

// ---- 依赖：dsh-see-now 是 peer，缺失时优雅禁用，不拖垮 dsh ----
let spawnFrames, createPipeline;
try {
  ({ spawnFrames } = await import('dsh-see-now/capture'));
  ({ createPipeline } = await import('dsh-see-now/pipeline'));
} catch (e) {
  log(`disabled: dsh-see-now not available (${e.message}). Install it first.`);
}

/** 找 ffmpeg：优先 DSH 自带，再 PATH。跨平台。 */
function resolveFfmpeg() {
  const name = platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const explicit = process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || '';
  if (explicit) return explicit;
  for (const p of [join(dshHome(), 'tools', 'ffmpeg', 'bin', name), join(dshHome(), 'bin', name)]) {
    if (existsSync(p)) return p;
  }
  return name; // 交给 PATH
}

/** 从 dsh-pet 日志里找当前 HTTP 端口（DSH 重启会变）。 */
function findPort() {
  try {
    const tail = readFileSync(PET_LOG, 'utf8').split(/\r?\n/).slice(-400);
    let port = null;
    for (const line of tail) {
      const m = line.match(/config:\s*http:\/\/127\.0\.0\.1:(\d+)\/dsh-pet-7340\/config/);
      if (m) port = m[1];
    }
    return port;
  } catch { return null; }
}

/** pet 是否在：能读到端口且 /config 可访问，就认为 pet 开着（跨平台，不查进程）。 */
async function checkPet() {
  const port = findPort();
  if (!port) return { up: false, base: null };
  const base = `http://127.0.0.1:${port}/dsh-pet-7340`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    let r;
    try { r = await fetch(`${base}/config`, { signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    return { up: r.ok, base };
  } catch { return { up: false, base }; }
}

/** 用 Node 原生 fetch 把图 POST 给 pet（无 curl 依赖）。 */
async function postImage(base, pngBuffer) {
  const payload = JSON.stringify({
    text: PROMPT,
    attachment: { mediaType: 'image/png', data: pngBuffer.toString('base64') },
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/chat?pet=main&surface=desktop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
      signal: ctrl.signal,
    });
    return { status: r.status, body: (await r.text()).trim() };
  } finally { clearTimeout(t); }
}

/**
 * dsh 加载插件时调用。
 * @returns {() => void} dispose，dsh 卸载 / 关闭时调用。
 */
export async function apply(ctx) {
  if (!spawnFrames || !createPipeline) {
    log('apply: skipped (dsh-see-now missing)');
    return () => {};
  }
  const ffmpegPath = resolveFfmpeg();
  log(`apply: ffmpeg=${ffmpegPath} ${W}x${H}@${FPS} minGap=${MIN_GAP_MS}ms`);

  let disposed = false;
  let petAlive = false;
  let petBase = null;
  let lastPetCheck = 0;
  let restartTimer = null;
  let ffmpeg = null;
  let captureOn = false;
  let pendingSheet = null;
  let lastSentAt = 0;
  let inflight = false;
  let backoffUntil = 0;
  let consecutiveFails = 0;

  const pipeline = createPipeline({
    width: W, height: H, fps: FPS,
    cutAbs: 20, cutIsolatedAbs: 0, cutMcAbs: 0,
    floorGapK: 3, floorMin: 3, floorMax: 30,
    queueDepth: 0,
  });

  function startCapture() {
    if (captureOn || disposed) return;
    try {
      ffmpeg = spawnFrames({
        source: { kind: 'screen' }, width: W, height: H, fps: FPS, ffmpegPath,
        onFrame: (f) => pipeline.push(f), onStderr: null,
      });
      captureOn = true;
      log('capture started');
      void ffmpeg.done.catch((e) => {
        if (disposed || !captureOn) return;
        log(`ffmpeg exited: ${e.message} — restart in 3s`);
        captureOn = false; ffmpeg = null;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (petAlive) startCapture(); }, 3000);
      });
    } catch (e) { log(`spawnFrames FATAL: ${e.stack || e.message}`); }
  }

  function stopCapture() {
    if (!captureOn) return;
    captureOn = false;
    clearTimeout(restartTimer);
    const f = ffmpeg; ffmpeg = null;
    try { f?.stop(); } catch { /* ignore */ }
    pendingSheet = null;
    log('capture stopped');
  }

  async function drain() {
    if (inflight || disposed || !petAlive || !petBase) return;
    const now = Date.now();
    if (now < backoffUntil || now - lastSentAt < MIN_GAP_MS) return;
    if (!pendingSheet) return;
    const sheet = pendingSheet;
    pendingSheet = null;
    inflight = true;
    try {
      const { status, body } = await postImage(petBase, sheet.png);
      if (status >= 200 && status < 300) {
        lastSentAt = Date.now(); consecutiveFails = 0;
        log(`OK status=${status} sheet@${sheet.at}s why=${sheet.why} :: ${body.slice(0, 160)}`);
        try { appendFileSync(WATCH_LOG, `${new Date().toISOString()} OK ${body}\n`, 'utf8'); } catch { /* ignore */ }
      } else if (status === 429 || status >= 500) {
        const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * (2 ** consecutiveFails));
        backoffUntil = Date.now() + delay; consecutiveFails += 1;
        log(`THROTTLE status=${status} → backoff ${delay}ms`);
      } else {
        consecutiveFails += 1;
        log(`FAIL status=${status} :: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      consecutiveFails += 1;
      const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * (2 ** Math.min(consecutiveFails - 1, 5)));
      backoffUntil = Date.now() + delay;
      log(`ERR ${e.message} → backoff ${delay}ms`);
    } finally { inflight = false; }
  }

  function onSheet(sheet) {
    pendingSheet = sheet;
    void drain();
  }

  const tick = setInterval(async () => {
    if (disposed) return;
    const now = Date.now();
    if (now - lastPetCheck >= PET_POLL_MS) {
      lastPetCheck = now;
      const { up, base } = await checkPet();
      petBase = base;
      if (up !== petAlive) {
        petAlive = up;
        if (up) { log('pet ONLINE → start'); startCapture(); }
        else { log('pet OFFLINE → stop'); stopCapture(); }
      }
    }
    if (!petAlive || !captureOn) return;
    try { const s = pipeline.take(); if (s) onSheet(s); } catch (e) { log(`take ERR: ${e.message}`); }
    void drain();
  }, TICK_MS);

  const init = await checkPet();
  petAlive = init.up; petBase = init.base; lastPetCheck = Date.now();
  log(`initial pet: ${petAlive ? 'ONLINE' : 'OFFLINE'}`);
  if (petAlive) startCapture();

  return () => {
    if (disposed) return;
    disposed = true;
    log('dispose: cleaning up');
    clearInterval(tick);
    clearTimeout(restartTimer);
    stopCapture();
  };
}

export default apply;
