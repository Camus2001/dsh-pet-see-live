/**
 * dsh-pet-see-live — 让 dsh-pet 实时"看见"屏幕并点评。
 *
 * 本插件只做一件事：把 dsh-see-now 出的图接到 dsh-pet 的 /chat。
 * 采集/拼图/节奏/档位等一切参数都跟随 see-now 自身的设置
 * （~/.dsh/see-now.json 的 defaultPace / fps，以及 see-now 内置的 PACES/SIZES），
 * 插件本身不提供任何独立变量。
 *
 * 生命周期：随 dsh 加载/卸载；pet 关闭时自动停采集，pet 再开自动恢复。
 * 跨平台：Windows / macOS / Linux，不依赖 PowerShell / curl。
 */
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// 路径全部从 DSH_HOME / home 动态解析
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
const PET_DIR = join(dshHome(), 'dsh-pet');
const PET_LOG = join(PET_DIR, 'logs.txt');
const WATCH_LOG = join(PET_DIR, 'screen-watch.log');
const SELF_LOG = join(PET_DIR, 'see-live-plugin.log');
const SEE_NOW_CFG = join(dshHome(), 'see-now.json');

function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(SELF_LOG, s, 'utf8'); } catch { /* ignore */ }
}

// see-now 的节奏/档位定义（捕获异常：缺失时优雅禁用）
let spawnFrames, createPipeline, PACES, SIZES, DEFAULT_PACE, DEFAULT_QUALITY;
try {
  ({ spawnFrames } = await import('dsh-see-now/capture'));
  ({ createPipeline } = await import('dsh-see-now/pipeline'));
  ({ PACES, SIZES, DEFAULT_PACE, DEFAULT_QUALITY } = await import('dsh-see-now/runner'));
} catch (e) {
  log(`disabled: dsh-see-now not available (${e.message}). Install it first.`);
}

/** 读 see-now 自己的配置（节奏 / fps），没有就用 see-now 的默认值。 */
function seeNowSettings() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(SEE_NOW_CFG, 'utf8')); } catch { /* 用默认 */ }
  const pace = PACES[raw.defaultPace] ? raw.defaultPace : DEFAULT_PACE;
  const fps = Number.isFinite(Number(raw.fps)) && Number(raw.fps) > 0 ? Number(raw.fps) : 12;
  return { pace, fps, p: PACES[pace] };
}

/** 找 ffmpeg：优先 DSH 自带，再 PATH。跨平台。 */
function resolveFfmpeg() {
  const name = platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const explicit = process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || '';
  if (explicit) return explicit;
  for (const p of [join(dshHome(), 'tools', 'ffmpeg', 'bin', name), join(dshHome(), 'bin', name)]) {
    if (existsSync(p)) return p;
  }
  return name;
}

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

/** pet 是否在：端口可达即 pet 开着（跨平台，不查进程）。 */
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

/**
 * 把 see-now 图集的帧清单写成 pet 能读懂的时间顺序说明。
 *
 * 图里每格虽然烧了编号，但只发 PNG 的话模型不知道编号代表什么；
 * see-now 原本会在工具文本里附带 frame@时间码，这里补上同一份信息。
 */
function sheetPrompt(sheet) {
  const frames = Array.isArray(sheet?.frames) ? sheet.frames : [];
  if (frames.length < 2) return '看一眼我现在的屏幕，用简短一句话吐槽或评价，不超过20字。';
  const first = Number(frames[0].t) || 0;
  const last = Number(frames[frames.length - 1].t) || first;
  const times = frames
    .map((f, i) => `${i + 1}=+${Math.max(0, (Number(f.t) || 0) - first).toFixed(1)}s`)
    .join('、');
  return [
    `这是一张按时间采样的连拍图集，不是一张静态截图：共 ${frames.length} 帧，`
      + `每格左上角的编号 1→${frames.length} 就是真实时间顺序（1 最早，${frames.length} 最晚），`
      + '不要按左右/上下阅读顺序理解。',
    `各帧相对第 1 帧的时刻：${times}；整段跨度 ${Math.max(0, last - first).toFixed(1)} 秒。`,
    '按编号的时间顺序看，然后用你平时的语气随口说一两句，别写成流水账。',
  ].join('\n');
}

/** 把一张图喂给 pet（Node 原生 fetch，无 curl 依赖）。 */
async function postImage(base, sheet) {
  const payload = JSON.stringify({
    text: sheetPrompt(sheet),
    attachment: { mediaType: 'image/png', data: sheet.png.toString('base64') },
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
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
  if (!spawnFrames || !createPipeline || !PACES) {
    log('apply: skipped (dsh-see-now missing)');
    return () => {};
  }
  const { pace, fps, p } = seeNowSettings();
  const [width, height] = SIZES[DEFAULT_QUALITY];
  const wakeGapMs = p.wakeGapSec * 1000;   // see-now 自己的"多久叫醒一次"
  const ffmpegPath = resolveFfmpeg();
  log(`apply: pace=${pace} fps=${fps} ${width}x${height} wakeGap=${wakeGapMs}ms ffmpeg=${ffmpegPath}`);

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

  // 出图参数全部来自 see-now 的 pace（cutAbs + pipeline.*），分辨率用 see-now 默认档
  const pipeline = createPipeline({
    width, height, fps,
    cutAbs: p.cutAbs,
    ...p.pipeline,
  });

  function startCapture() {
    if (captureOn || disposed) return;
    try {
      ffmpeg = spawnFrames({
        source: { kind: 'screen' }, width, height, fps, ffmpegPath,
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

  /** 统一退避：dsh-pet 把生成失败/限流都包成 HTTP 200 + body.ok=false，必须看 body 才不会误判成功。 */
  function backoff(reason) {
    const delay = Math.min(300000, 30000 * (2 ** Math.min(consecutiveFails, 5)));
    backoffUntil = Date.now() + delay;
    consecutiveFails += 1;
    log(`${reason} → backoff ${delay}ms`);
  }

  async function drain() {
    if (inflight || disposed || !petAlive || !petBase) return;
    const now = Date.now();
    if (now < backoffUntil || now - lastSentAt < wakeGapMs) return;
    if (!pendingSheet) return;
    const sheet = pendingSheet;
    pendingSheet = null;
    inflight = true;
    try {
      const { status, body } = await postImage(petBase, sheet);
      // dsh-pet 的 /chat 用 okResult/failResult 包装，成功与失败都是 HTTP 200，
      // 区别只在 body 的 ok 字段。这里必须解 body，否则限流/超时会被当成成功继续喂图。
      let bodyOk = true;
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.ok === false) bodyOk = false;
      } catch { /* 非 JSON 无法判断，按成功处理（pet 正常返回都是 JSON） */ }
      if (status >= 200 && status < 300 && bodyOk) {
        lastSentAt = Date.now(); consecutiveFails = 0;
        log(`OK status=${status} sheet@${sheet.at}s why=${sheet.why} :: ${body.slice(0, 160)}`);
        try { appendFileSync(WATCH_LOG, `${new Date().toISOString()} OK ${body}\n`, 'utf8'); } catch { /* ignore */ }
      } else if (status === 429 || status >= 500) {
        backoff(`THROTTLE status=${status}`);
      } else if (status >= 200 && status < 300 && !bodyOk) {
        // 限流 / 余额不足 / 超时等：HTTP 200 但 body.ok=false
        backoff(`SOFT-FAIL body.ok=false :: ${body.slice(0, 160)}`);
        try { appendFileSync(WATCH_LOG, `${new Date().toISOString()} SOFT-FAIL ${body}\n`, 'utf8'); } catch { /* ignore */ }
      } else {
        consecutiveFails += 1;
        log(`FAIL status=${status} :: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      backoff(`ERR ${e.message}`);
    } finally { inflight = false; }
  }

  const tick = setInterval(async () => {
    if (disposed) return;
    const now = Date.now();
    if (now - lastPetCheck >= 2000) {
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
    try { const s = pipeline.take(); if (s) { pendingSheet = s; void drain(); } } catch (e) { log(`take ERR: ${e.message}`); }
    void drain();
  }, 1000);

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
