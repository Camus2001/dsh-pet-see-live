/**
 * dsh-pet-see-live — 让 dsh-pet 实时"看见"屏幕、并"听见"同期声音后点评。
 *
 * 本插件做两件事：
 *   1. 把 dsh-see-now 出的图接到 dsh-pet 的 /chat（原样保留）；
 *   2. 复用 see-now 的 listener 采集系统回放音频，并用 see-now 自己的识别配置转写成台词，
 *      并进图集提示词，让 pet 同时"看到 + 听到"再点评。
 *
 * 采集/拼图/节奏/档位/听音参数全部跟随 see-now 自身的设置（~/.dsh/see-now.json 与
 * see-now 内置的 PACES/SIZES/LISTEN_DEFAULTS）。
 * 本插件自己的开关只有：音频开关 listenEnabled 与聚焦暂停 pauseOnFocus，存于 ~/.dsh/pet-see-live.json。
 * 与 see-now 一样，改设置后要重启 DSH 生效。
 *
 * 生命周期：随 dsh 加载/卸载；pet 关闭时自动停采集与听音，pet 再开自动恢复。
 * 跨平台：Windows / macOS / Linux（听音在 Windows 上依赖 pyaudiowpatch + numpy）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 路径全部从 DSH_HOME / home 动态解析
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
const PET_DIR = join(dshHome(), 'dsh-pet');
const WATCH_LOG = join(PET_DIR, 'screen-watch.log');
const SELF_LOG = join(PET_DIR, 'see-live-plugin.log');
const SEE_NOW_CFG = join(dshHome(), 'see-now.json');
const PET_SEE_CFG = join(dshHome(), 'pet-see-live.json');
// 独立于 see-now 自己的 ~/.dsh/see-now/audio：两个 listener 共用目录会互相杀进程、抢 seg-*.wav。
// dir 只是 WAV 暂存位置，不影响识别配置（识别仍走 see-now 的 resolveTranscriber / asr.json）。
const AUDIO_DIR = join(PET_DIR, 'see-live-audio');
const API_PREFIX = '/api/pet-see-live';

// 会话重置：每次发图前读一次 dsh-ntr 的 ACP 会话用量，超过阈值就关闭并重建。
// 阈值是 ACP 上下文 token（session/chat-list 的 usage.used），不是 pet 的 memory.json 条数。
const DEFAULT_SESSION_RESET_THRESHOLD = 200_000;
const SESSION_RESET_MIN_GAP_MS = 60_000;        // 两次重置之间至少隔一分钟，防抖
const SESSION_RESET_FAIL_COOLDOWN_MS = 300_000; // RPC 失败后 5 分钟内不再试，避免刷日志
const ACP_AUTH_TTL_MS = 10 * 60_000;            // /connect 拿到的 cookie 复用 10 分钟
// CodeBuddy 把每个会话的 transcript 落在 ~/.codebuddy/projects/<project>/<sessionId>.jsonl。
// 只关闭 ACP 会话时 CodeBuddy 会在下一次 prompt 里重新加载这份 transcript，上下文并不会清空；
// 要真正重置，必须在 close 之后把这份文件删掉。
const CODEBUDDY_HOME_DIR = process.env.CODEBUDDY_HOME || join(homedir(), '.codebuddy');
const CODEBUDDY_PROJECTS = join(CODEBUDDY_HOME_DIR, 'projects');

/** 删除 CodeBuddy 某个会话的 transcript；返回是否真的删掉了文件。 */
function deleteCodeBuddyTranscript(acpSessionId) {
  if (typeof acpSessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(acpSessionId)) return false;
  let dirs = [];
  try {
    dirs = readdirSync(CODEBUDDY_PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return false; }
  for (const dir of dirs) {
    const file = join(CODEBUDDY_PROJECTS, dir, `${acpSessionId}.jsonl`);
    if (!existsSync(file)) continue;
    try {
      unlinkSync(file);
      return true;
    } catch (e) {
      log(`session reset: transcript delete failed (${e.message})`);
      return false;
    }
  }
  return false;
}

function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(SELF_LOG, s, 'utf8'); } catch { /* ignore */ }
}

// 前台信号由渲染端给：client.js 监听窗口 focus/blur 与 visibilitychange，事件变化立刻上报，
// 之后每 15s 一次心跳；宿主侧 30s 收不到心跳就当作"不可信"，一律按不在前台处理（保持抓屏），
// 这样渲染端崩溃 / 页面重载时最多退化成"不暂停"，不会把采集永久卡住。
const FOCUS_FRESH_MS = 30_000;

// see-now 的节奏/档位定义（捕获异常：缺失时优雅禁用）
let spawnFrames, createPipeline, PACES, SIZES, DEFAULT_PACE, DEFAULT_QUALITY;
try {
  ({ spawnFrames } = await import('dsh-see-now/capture'));
  ({ createPipeline } = await import('dsh-see-now/pipeline'));
  ({ PACES, SIZES, DEFAULT_PACE, DEFAULT_QUALITY } = await import('dsh-see-now/runner'));
} catch (e) {
  log(`disabled: dsh-see-now not available (${e.message}). Install it first.`);
}

// see-now 的设置读取器：与它自己的设置页共用同一份校验逻辑。
// `dsh-see-now` 的 exports 没有暴露 `./tuning`，所以从包根定位 `src/tuning.js`。
// 缺失时退回只读 see-now.json 的旧路径（至少 pace / fps 仍可用）。
async function importSeeNowFile(rel) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('dsh-see-now/package.json');
  return import(pathToFileURL(join(dirname(pkg), rel)).href);
}

let readSeeNowTuning = null;
let LISTEN_DEFAULTS = null;
try {
  ({ readTuning: readSeeNowTuning, LISTEN_DEFAULTS } = await importSeeNowFile('src/tuning.js'));
} catch (e) {
  log(`tuning reader unavailable (${e.message}); only defaultPace/fps will follow see-now`);
}

// see-now 的 listener（音频采集 + 转写调度）同样不在 exports 里，从包根深路径导入。
// 导入失败只关掉听音功能，不影响抓屏。
// 转写完全交给 listener 自己：它内部用 see-now 的 resolveTranscriber，
// 读取 see-now 设置页的 prefer / live / silence 等以及 ~/.dsh/asr.json，本插件不另做识别配置。
let createListener = null;
try {
  ({ createListener } = await importSeeNowFile('src/listen.js'));
} catch (e) {
  log(`listener unavailable (${e.message}); audio listening disabled`);
}

/** 读本插件自己的设置：语音识别、聚焦暂停、ACP 会话重置。 */
function readPetSeeConfig() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(PET_SEE_CFG, 'utf8')); } catch { /* 用默认 */ }
  const threshold = Number(raw.sessionResetThreshold);
  return {
    listenEnabled: raw.listenEnabled === true,
    pauseOnFocus: raw.pauseOnFocus !== false,   // 默认开启
    sessionResetEnabled: raw.sessionResetEnabled === true,
    sessionResetThreshold: Number.isFinite(threshold)
      ? Math.min(2_000_000, Math.max(4096, Math.round(threshold)))
      : DEFAULT_SESSION_RESET_THRESHOLD,
  };
}

/** 写设置（设置页落盘用；只在 POST /config 里调用）。 */
function writePetSeeConfig(patch) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(PET_SEE_CFG, 'utf8')); } catch { /* 新建 */ }
  const next = { ...raw, ...patch };
  writeFileSync(PET_SEE_CFG, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** 读 see-now 自己的配置（节奏 / fps / 档位参数），没有就用 see-now 的默认值。 */
function seeNowSettings() {
  let tuning = null;
  if (readSeeNowTuning) {
    try {
      tuning = readSeeNowTuning();
      if (Array.isArray(tuning.warnings) && tuning.warnings.length > 0) {
        log(`see-now tuning warnings: ${tuning.warnings.join('; ')}`);
      }
    } catch (e) {
      log(`readTuning failed: ${e.message}`);
      tuning = null;
    }
  }
  let raw = {};
  try { raw = JSON.parse(readFileSync(SEE_NOW_CFG, 'utf8')); } catch { /* 用默认 */ }
  const paceName = tuning?.defaultPace ?? raw.defaultPace;
  const pace = PACES[paceName] ? paceName : DEFAULT_PACE;
  const fpsRaw = Number(tuning?.fps ?? raw.fps);
  const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 12;
  return { pace, fps, p: PACES[pace], tuning };
}

/** see-now 设置页里能落到 pipeline 的项：tierStyle 在 pipeline 里叫 strategy。 */
function pipelineTuningOf(tuning) {
  if (!tuning) return {};
  return {
    strategy: tuning.tierStyle,
    tierMap: tuning.tierMap,
    tierMode: tuning.tierMode,
    tierCurve: tuning.tierCurve,
    tierThresholds: tuning.tierThresholds,
    scoreNormalize: tuning.scoreNormalize,
    maxCrop: tuning.maxCrop,
  };
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

// 正规接口：pet 的 HTTP 路由挂在 DSH 的 webServer 上，端口直接读它暴露的 port。
// dsh-pet 自己也用 ctx.webServer.port（见其 app.js），不再解析 logs.txt 里的 config 行。
/** pet 是否在：端口可达即 pet 开着（跨平台，不查进程）。 */
async function checkPet(ctx, webServer) {
  let ws = webServer;
  if (!ws && ctx) {
    // 注入回调可能晚于首次检查；ctx.webServer 未注入时 getter 会抛，吞掉即可。
    try { ws = ctx.webServer ?? null; } catch { /* 服务还没就绪 */ }
  }
  const port = typeof ws?.port === 'number' ? ws.port : 0;
  if (!port || port <= 0) return { up: false, base: null };
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

/** 挂设置页用的同源 HTTP API：GET /status、POST /config；并把 connection 交给会话重置用。 */
function installSettingsApi(ctx, focus, onWebServer, onConnection) {
  if (!ctx?.inject) return;
  try {
    ctx.inject(['webServer'], (scoped) => {
      onWebServer(scoped.webServer);   // 捕获 DSH 注入的 webServer，供 checkPet 读取端口
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix', path: API_PREFIX, auth: 'required',
        handler: (req, res) => { void handleSettingsRequest(req, res, focus); },
      }, 'dsh-pet-see-live: settings routes'));
    });
  } catch (e) {
    log(`settings API unavailable: ${e.message}`);
  }
  try {
    // 只用于读/关 dsh-ntr 的 ACP 会话；拿不到时重置功能静默跳过，不影响抓屏与设置页。
    ctx.inject(['connection'], (scoped) => { onConnection(scoped.connection); });
  } catch (e) {
    log(`connection unavailable: ${e.message}`);
  }
}

async function handleSettingsRequest(req, res, focus) {
  const send = (status, obj) => {
    try {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
    } catch (e) { log(`settings API respond ERR: ${e.message}`); }
  };
  try {
    const origin = String(req.headers?.origin || '');
    if (origin && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
      send(403, { ok: false, reason: 'forbidden' });
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === API_PREFIX || url.pathname === `${API_PREFIX}/status`)) {
      send(200, { ok: true, ...readPetSeeConfig() });
      return;
    }
    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/config`) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { send(400, { ok: false, reason: 'bad-json' }); return; }
      const patch = {};
      let bad = false;
      if (Object.hasOwn(body, 'listenEnabled')) {
        if (typeof body.listenEnabled === 'boolean') patch.listenEnabled = body.listenEnabled;
        else bad = true;
      }
      if (Object.hasOwn(body, 'pauseOnFocus')) {
        if (typeof body.pauseOnFocus === 'boolean') patch.pauseOnFocus = body.pauseOnFocus;
        else bad = true;
      }
      if (Object.hasOwn(body, 'sessionResetEnabled')) {
        if (typeof body.sessionResetEnabled === 'boolean') patch.sessionResetEnabled = body.sessionResetEnabled;
        else bad = true;
      }
      if (Object.hasOwn(body, 'sessionResetThreshold')) {
        const n = Number(body.sessionResetThreshold);
        if (Number.isFinite(n) && n >= 4096 && n <= 2_000_000) patch.sessionResetThreshold = Math.round(n);
        else bad = true;
      }
      if (bad || Object.keys(patch).length === 0) {
        send(400, { ok: false, reason: 'bad-config' });
        return;
      }
      writePetSeeConfig(patch);
      send(200, { ok: true, ...readPetSeeConfig() });
      return;
    }
    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/focus`) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { send(400, { ok: false, reason: 'bad-json' }); return; }
      if (typeof body?.focused !== 'boolean') {
        send(400, { ok: false, reason: 'bad-config' });
        return;
      }
      focus.report = { focused: body.focused, at: Date.now() };
      if (!focus.seen) {
        focus.seen = true;
        log(`focus signal from renderer: ${body.focused ? 'focused' : 'blurred'}`);
      }
      send(200, { ok: true });
      return;
    }
    send(404, { ok: false, reason: 'not-found' });
  } catch (e) {
    send(500, { ok: false, reason: e.message });
  }
}

/**
 * 把 see-now 图集的画面清单写成 pet 能读懂的时间顺序说明。
 *
 * 图里每格虽然烧了编号，但只发 PNG 的话模型不知道编号代表什么；
 * see-now 原本会在工具文本里附带 frame@时间码，这里补上同一份信息。
 * 开头标明“来自 dsh-pet”，让 CodeBuddy 的 CODEBUDDY.md 里那条
 * “当请求来自 dsh-pet 时按桌宠人设回答”的条件能生效。
 */
const PET_SOURCE_TAG = '（来自dsh-pet）';

function sheetPrompt(sheet) {
  const frames = Array.isArray(sheet?.frames) ? sheet.frames : [];
  const lines = linesBlock(sheet?.lines);
  const first = Number(frames[0]?.t) || 0;
  const last = Number(frames[frames.length - 1]?.t) || first;
  const times = frames
    .map((f, i) => `${i + 1}=+${Math.max(0, (Number(f.t) || 0) - first).toFixed(1)}s`)
    .join('、');
  return [
    PET_SOURCE_TAG,
    `这是一张按时间采样的连拍图集，不是一张静态截图：一共 ${frames.length} 张画面，`
      + `每格左上角的编号 1→${frames.length} 就是真实时间顺序（1 最早，${frames.length} 最晚），`
      + '不要按左右/上下阅读顺序理解。',
    `每张画面相对第一张的时刻：${times}；整段跨度 ${Math.max(0, last - first).toFixed(1)} 秒。`,
    '按时间顺序看完，你的想法是什么？',
    lines,
  ].filter(Boolean).join('\n');
}

/** 把 listener.between() 的台词条目写成 pet 能读懂的同期语音说明。 */
function linesBlock(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const texts = lines
    .map((l) => (typeof l?.text === 'string' ? l.text.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
  if (texts.length === 0) return '';
  return `\n【屏幕同期语音（按时间顺序）】：${texts.join(' / ')}。结合画面和这些话一起评价。`;
}

/** 桌宠 /chat 对 attachment.data 的 base64 上限（对应 dsh-pet 的 MAX_BASE64_CHARS）。 */
const PET_MAX_B64 = Number(process.env.DSH_PET_MAX_B64 || 900_000);

/** PNG → JPEG：桌宠接受 image/jpeg，q=4 时 798×450 的截图通常只有原 PNG 的四分之一体积。 */
function pngToJpeg(png, ffmpegPath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-v', 'error',
        '-f', 'image2pipe', '-i', 'pipe:0',
        '-frames:v', '1', '-q:v', '4',
        '-f', 'image2pipe', 'pipe:1',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { reject(e); return; }
    const out = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('jpeg timeout'));
    }, 10_000);
    child.stdout?.on('data', (d) => out.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length > 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}`));
    });
    child.stdin?.on('error', () => { /* 进程提前退出会 EPIPE，留给 close 判定 */ });
    child.stdin?.end(png);
  });
}

/** 按桌宠的上限挑一个能发出去的附件；JPEG 也放不下就返回 null（调用方跳过这张，不算失败）。 */
async function fitAttachment(png, ffmpegPath) {
  const pngB64 = png.toString('base64');
  if (pngB64.length <= PET_MAX_B64) return { mediaType: 'image/png', data: pngB64 };
  const jpg = await pngToJpeg(png, ffmpegPath).catch((e) => {
    log(`jpeg encode failed: ${e.message}`);
    return null;
  });
  if (jpg) {
    const jpgB64 = jpg.toString('base64');
    if (jpgB64.length <= PET_MAX_B64) return { mediaType: 'image/jpeg', data: jpgB64 };
  }
  log(`attachment too large after jpeg: pngB64=${pngB64.length}`);
  return null;
}

/** 把一张图喂给 pet（Node 原生 fetch，无 curl 依赖）。externalSignal 用于失焦时取消在途请求。 */
async function postImage(base, sheet, externalSignal, ffmpegPath) {
  const attachment = await fitAttachment(sheet.png, ffmpegPath);
  if (!attachment) return { skipped: true };
  const payload = JSON.stringify({
    text: sheetPrompt(sheet),
    attachment,
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const r = await fetch(`${base}/chat?pet=main&surface=desktop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
      signal: ctrl.signal,
    });
    return { status: r.status, body: (await r.text()).trim() };
  } finally {
    clearTimeout(t);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
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
  const { pace, fps, p, tuning } = seeNowSettings();
  const { listenEnabled, pauseOnFocus, sessionResetEnabled, sessionResetThreshold } = readPetSeeConfig();
  const quality = DEFAULT_QUALITY;
  const [width, height] = SIZES[quality];
  const wakeGapMs = p.wakeGapSec * 1000;   // see-now 自己的"多久叫醒一次"
  const ffmpegPath = resolveFfmpeg();
  log(
    `apply: pace=${pace} fps=${fps} ${width}x${height} quality=${quality}`
      + ` listen=${listenEnabled && createListener ? 'on' : 'off'} pauseOnFocus=${pauseOnFocus}`
      + ` reset=${sessionResetEnabled ? `${sessionResetThreshold}` : 'off'}`
      + ` wakeGap=${wakeGapMs}ms`
      + ` tier=${tuning ? `${tuning.tierStyle}/${tuning.tierMode}/${tuning.tierCurve}` : 'defaults'}`
      + ` ffmpeg=${ffmpegPath}`,
  );
  const focus = { report: null, seen: false };
  let webServer = null;
  let connection = null;
  installSettingsApi(ctx, focus, (ws) => { webServer = ws; }, (c) => { connection = c; });

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
  let drainAbort = null;
  // 听音状态：随 pet 上下线，与抓屏并行但独立
  let listener = null;
  let listenOn = false;
  let lastWallTo = 0;
  // 焦点状态：DSH 前台时暂停识图识音
  let dshFocused = false;
  // 听音细节全部沿用 see-now：listen 段直接来自它的 tuning（prefer / live / silence / maxSeg…）
  const listenCfg = {
    ...(LISTEN_DEFAULTS || {}),
    ...(tuning?.listen ?? {}),
  };

  const canRun = () => petAlive && !dshFocused && !disposed;

  /** 渲染端心跳新鲜才采信；过期视为"不在前台"。 */
  const focusState = () => {
    if (!focus.report || Date.now() - focus.report.at > FOCUS_FRESH_MS) return false;
    return focus.report.focused === true;
  };

  // 出图参数全部来自 see-now：pace 管 cutAbs / 兜底节奏，设置页的档位参数走 tuning
  const pipelineOpts = {
    width, height, fps,
    cutAbs: p.cutAbs,
    ...p.pipeline,
    ...pipelineTuningOf(tuning),
  };
  let pipeline = null;   // 由 startCapture 惰性创建，避免重建时白做一次

  function startCapture() {
    if (captureOn || disposed || dshFocused) return;
    try {
      // 每次重开 ffmpeg，帧时间戳都从 0 重来；pipeline 里的 lastCut / lastBound / sheetStart
      // 还是上一轮的秒数，时间轴回退后所有判据都不成立，会一直不出图。
      // 重建一根新管子：状态与时间轴一起归零，顺带丢掉上一轮的半成品。
      pipeline = createPipeline(pipelineOpts);
      pendingSheet = null;
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
        restartTimer = setTimeout(() => { if (canRun()) startCapture(); }, 3000);
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

  /** 焦点切换：聚焦 DSH 时暂停抓屏/听音并取消在途喂图；离开后在 pet 在线时恢复。 */
  function setFocused(next) {
    if (next === dshFocused || !pauseOnFocus) return;
    dshFocused = next;
    if (next) {
      log('DSH focused → pause');
      try { drainAbort?.abort(); } catch { /* ignore */ }
      stopCapture();
      stopListen();
    } else {
      if (canRun()) {
        log('DSH unfocused → resume');
        startCapture();
        void startListen();
      }
    }
  }

  /** 开听音：pet 在线且设置打开才启动；缺依赖 / DSH_SEE_AUDIO=0 时 listener 自己会返回 ok=false。 */
  async function startListen() {
    if (listenOn || disposed || dshFocused || !listenEnabled || !createListener) return;
    listenOn = true;
    try {
      const l = createListener({
        ctx,                       // listener 内部用 ctx.get('speechToText') → see-now 的宿主识别
        dir: AUDIO_DIR,
        listen: listenCfg,         // see-now 的 listen 设置（prefer / live / silence…）
        log: (s) => log(`[listen] ${s}`),
        // 不注入 transcriber：让 listener 走 see-now 自己的 resolveTranscriber，
        // 读取 ~/.dsh/see-now.json 的 prefer 与 ~/.dsh/asr.json 的本地识别配置。
      });
      const r = await l.start();
      // await 期间 pet 可能已下线、插件被卸载或 DSH 变前台，立刻回滚
      if (!canRun()) {
        try { l.stop('race'); } catch { /* ignore */ }
        listenOn = false;
        return;
      }
      log(`listen start ${JSON.stringify(r)}`);
      if (r && r.ok) { listener = l; lastWallTo = 0; }
      else { listenOn = false; }
    } catch (e) {
      log(`listen FATAL: ${e.stack || e.message}`);
      listenOn = false;
    }
  }

  /** 停听音：清掉台词游标，避免下次重启重复喂同一批台词。 */
  function stopListen() {
    if (!listenOn && !listener) return;
    listenOn = false;
    const l = listener;
    listener = null;
    lastWallTo = 0;
    try { l?.stop('pet offline'); } catch { /* ignore */ }
    log('listen stopped');
  }

  /** 统一退避：dsh-pet 把生成失败/限流都包成 HTTP 200 + body.ok=false，必须看 body 才不会误判成功。 */
  function backoff(reason) {
    const delay = Math.min(300000, 30000 * (2 ** Math.min(consecutiveFails, 5)));
    backoffUntil = Date.now() + delay;
    consecutiveFails += 1;
    log(`${reason} → backoff ${delay}ms`);
  }

  // ---- ACP 会话重置 -------------------------------------------------------
  // 插件的 /chat 请求使用的是 dsh-pet 固定的 ACP 会话 'dsh-pet'。这里通过 dsh-ntr 的
  // /acp RPC 读它的上下文用量（usage.used），超过阈值时关闭这个 ACP 会话；下一次 pet
  // 请求会重新建一个空会话，从而把 26 万 token 的基线清掉。
  // 只用公开 RPC，不碰 dsh-ntr 的文件；dsh-ntr 不在或接口不可用时静默跳过。
  let acpAuth = null;          // { cookie, at }
  let lastResetAt = 0;
  let resetRetryAt = 0;
  let lastUsageWarnAt = 0;
  let lastUnavailableWarnAt = 0;

  function acpBase() {
    const port = typeof webServer?.port === 'number' ? webServer.port : 0;
    if (!port) return null;
    const scheme = webServer?.protocol === 'https:' ? 'https:' : 'http:';
    return `${scheme}//127.0.0.1:${port}`;
  }

  /** 用 DSH 的 launch token 走一次 /connect，拿到能调 /acp 的 API cookie。 */
  async function acpCookie(force = false) {
    if (!connection || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('connection.authenticatedUrl unavailable');
    }
    if (!force && acpAuth && Date.now() - acpAuth.at < ACP_AUTH_TTL_MS) return acpAuth.cookie;
    const base = acpBase();
    if (!base) throw new Error('webServer port unavailable');
    const url = connection.authenticatedUrl(`${base}/connect`);
    const r = await fetch(url, { redirect: 'manual' });
    const lines = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const raw = lines.length > 0 ? lines.join('\n') : (r.headers.get('set-cookie') || '');
    const hit = raw.match(/dsh-auth-[^=;\s]+=[^;]+/);
    if (!hit) throw new Error(`connect ${r.status}: no auth cookie`);
    acpAuth = { cookie: hit[0], at: Date.now() };
    return acpAuth.cookie;
  }

  /** 调 dsh-ntr 的 /acp/<method>，返回 result.value；失败抛出带原因的 Error。 */
  async function acpRpc(method, payload, signal) {
    const base = acpBase();
    if (!base) throw new Error('webServer port unavailable');
    const call = async (cookie) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 5000);
      const onAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
      if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await fetch(`${base}/acp/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    };
    let r = await call(await acpCookie(false));
    if (r.status === 401) r = await call(await acpCookie(true));
    if (!r.ok) throw new Error(`acp ${method} HTTP ${r.status}`);
    const body = await r.json();
    if (body?.type !== 'server-response') throw new Error(`acp ${method}: bad envelope`);
    const result = body.result;
    if (!result || result.ok !== true) {
      const code = result?.error?.code || 'failed';
      const msg = result?.error?.message || '';
      throw new Error(`acp ${method}: ${code}${msg ? ` ${msg}` : ''}`);
    }
    return result.value;
  }

  /** 取 chat 的会话元信息（不取 transcript 条目，afterSeq 给一个极大值）。 */
  async function acpSessionsMeta(signal) {
    const res = await acpRpc('session/chat-transcript', { dshSessionId: 'dsh-pet', afterSeq: 1e9 }, signal);
    return (Array.isArray(res?.views) ? res.views : [])
      .map((v) => v?.session)
      .filter(Boolean);
  }

  /**
   * 发图前检查一次：ACP 会话上下文超过阈值就关闭它。
   * 只在当前没有 turn 在跑时动手；失败只记日志，不阻塞本次发图。
   * @returns {Promise<boolean>} 是否真的重置了
   */
  async function maybeResetSession(signal) {
    const cfg = readPetSeeConfig();
    if (!cfg.sessionResetEnabled) return false;
    if (!connection) {
      if (Date.now() - lastUnavailableWarnAt > 600_000) {
        lastUnavailableWarnAt = Date.now();
        log('session reset: connection service unavailable, skipped');
      }
      return false;
    }
    if (!webServer?.port) return false;
    const now = Date.now();
    if (now < resetRetryAt || now - lastResetAt < SESSION_RESET_MIN_GAP_MS) return false;

    let list;
    try {
      list = await acpRpc('session/chat-list', { dshSessionId: 'dsh-pet' }, signal);
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      resetRetryAt = Date.now() + SESSION_RESET_FAIL_COOLDOWN_MS;
      log(`session reset: chat-list failed (${e.message})`);
      return false;
    }
    const rows = (Array.isArray(list?.sessions) ? list.sessions : [])
      .filter((s) => s && typeof s.sessionId === 'string');
    if (rows.length === 0) return false;   // 还没有 ACP 会话，下一次请求自然会新建
    const used = rows.reduce((max, s) => Math.max(max, Number(s.usage?.used) || 0), 0);
    if (used <= 0) {
      if (Date.now() - lastUsageWarnAt > 600_000) {
        lastUsageWarnAt = Date.now();
        log('session reset: ACP usage unavailable, skipped');
      }
      return false;
    }
    if (used < cfg.sessionResetThreshold) return false;
    if (rows.some((s) => s.running === true)) {
      resetRetryAt = Date.now() + 30_000;   // 等这一轮结束再试
      log(`session reset: skipped (turn running) used=${used} threshold=${cfg.sessionResetThreshold}`);
      return false;
    }

    // 先拿 ACP sessionId：close 之后 session/chat-transcript 就查不到了。
    let meta = [];
    try {
      meta = await acpSessionsMeta(signal);
    } catch { /* 拿不到只影响 transcript 轮换，close 仍然做 */ }

    const targets = rows.filter((s) => (Number(s.usage?.used) || 0) >= cfg.sessionResetThreshold);
    const transcripts = new Set();
    try {
      for (const s of targets) {
        const m = meta.find((v) => v.sessionId === s.sessionId);
        await acpRpc('session/close', { sessionId: s.sessionId }, signal);
        // CodeBuddy 会把关闭的会话保留在 transcript 里，下一次 prompt 又加载回来。
        // 只对 CodeBuddy 删文件；文件不存在时说明本来就没有可恢复的上下文。
        if (m?.agentId === 'codebuddy' && typeof m.acpSessionId === 'string') transcripts.add(m.acpSessionId);
      }
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      resetRetryAt = Date.now() + SESSION_RESET_FAIL_COOLDOWN_MS;
      log(`session reset: close failed (${e.message})`);
      return false;
    }
    lastResetAt = Date.now();
    log(`session reset: used=${used} threshold=${cfg.sessionResetThreshold} closed=${targets.length}`);
    // 给 agent 一点收尾时间，再删 transcript，避免它把旧内容又写回同一路径。
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const id of transcripts) {
      if (deleteCodeBuddyTranscript(id)) log(`session reset: transcript deleted (${id}.jsonl)`);
      else log('session reset: transcript not found or delete failed; CodeBuddy may resume the old context');
    }
    return true;
  }

  async function drain() {
    if (inflight || disposed || !canRun() || !petBase) return;
    const now = Date.now();
    if (now < backoffUntil || now - lastSentAt < wakeGapMs) return;
    if (!pendingSheet) return;
    const sheet = pendingSheet;
    pendingSheet = null;
    inflight = true;
    const ac = new AbortController();
    drainAbort = ac;
    try {
      // 发图前先看 ACP 会话是否已经太大；重置失败不阻塞本次点评。
      let didReset = false;
      await maybeResetSession(ac.signal).then((v) => { didReset = v; }).catch((e) => {
        if (e?.name !== 'AbortError') log(`session reset ERR: ${e.message}`);
      });
      if (ac.signal.aborted || !canRun()) return;
      let { status, body, skipped } = await postImage(petBase, sheet, ac.signal, ffmpegPath);
      // 刚重置出来的新 CodeBuddy 会话第一轮可能只发工具调用、没有正文（pet 回“模型未返回文本”）。
      // 这一轮之后工具结果已经进历史，重发一次通常就能正常出短评。
      if (didReset && !skipped) {
        let parsed;
        try { parsed = JSON.parse(body); } catch { /* 非 JSON 不重试 */ }
        if (parsed && parsed.ok === false && String(parsed.message || '').includes('模型未返回文本')) {
          log('session reset: first reply empty, retry once');
          await new Promise((resolve) => setTimeout(resolve, 1200));
          if (ac.signal.aborted || !canRun()) return;
          ({ status, body, skipped } = await postImage(petBase, sheet, ac.signal, ffmpegPath));
        }
      }
      if (skipped) {
        // 图放不下就没发请求：不进退避、不更新 lastSentAt，下一张照常试
        log(`SKIP sheet@${sheet.at}s why=${sheet.why} (attachment over ${PET_MAX_B64} b64 chars)`);
        return;
      }
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
      // 失焦导致的主动取消不算失败，不触发退避
      if (e?.name === 'AbortError' && dshFocused) log('drain aborted (DSH focused)');
      else backoff(`ERR ${e.message}`);
    } finally { inflight = false; drainAbort = null; }
  }

  let inTick = false;
  async function tick() {
    if (disposed || inTick) return;
    inTick = true;
    try {
      const now = Date.now();
      if (pauseOnFocus) setFocused(focusState());
      const pet = (now - lastPetCheck >= 2000) ? await checkPet(ctx, webServer) : null;
      if (pet) {
        lastPetCheck = Date.now();
        petBase = pet.base;
        if (pet.up !== petAlive) {
          petAlive = pet.up;
          if (pet.up) {
            if (canRun()) { log('pet ONLINE → start'); startCapture(); void startListen(); }
            else log('pet ONLINE → held (DSH focused)');
          } else { log('pet OFFLINE → stop'); stopCapture(); stopListen(); }
        }
      }
      // 失焦期间 DSH 聚焦已暂停抓屏，这里直接返回，不再取帧/喂图
      if (!canRun() || !captureOn) return;
      try {
        const s = pipeline.take();
        if (s) {
          // 把与这张图集同期的台词附上，时间窗与 see-now runner 的 attachLines 一致
          if (listener) {
            try {
              const to = s.wallTo ?? Date.now();
              const from = lastWallTo || Math.min(s.wallFrom ?? to, to - 20_000);
              const got = listener.between(from - 400, to + 800, { maxChars: 600 });
              if (to > lastWallTo) lastWallTo = to;
              if (got && got.length) s.lines = got;
            } catch (e) { log(`listen between ERR: ${e.message}`); }
          }
          pendingSheet = s;
        }
      } catch (e) { log(`take ERR: ${e.message}`); }
      void drain();
    } finally { inTick = false; }
  }

  // 初始化：先读焦点与 pet 状态，再决定是否启动；最后才注册定时器，避免首个 tick 竞态。
  if (pauseOnFocus) dshFocused = focusState();
  const init = await checkPet(ctx, webServer);
  petAlive = init.up; petBase = init.base;
  lastPetCheck = Date.now();
  log(`initial pet: ${petAlive ? 'ONLINE' : 'OFFLINE'} dshFocused=${dshFocused}`);
  if (canRun()) { startCapture(); void startListen(); }
  const ticker = setInterval(() => { void tick(); }, 1000);

  return () => {
    if (disposed) return;
    disposed = true;
    log('dispose: cleaning up');
    clearInterval(ticker);
    clearTimeout(restartTimer);
    try { drainAbort?.abort(); } catch { /* ignore */ }
    stopListen();
    stopCapture();
  };
}

export default apply;
