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
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
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

function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(SELF_LOG, s, 'utf8'); } catch { /* ignore */ }
}

// DSH 是否处于系统前台：插件跑在纯 Node（非 Electron 主进程），拿不到 BrowserWindow，
// 只能用 Python ctypes 调 Win32 GetForegroundWindow。识别 DSH 主程序进程名或桌宠窗口标题。
// 注意 64 位句柄必须设 restype=c_void_p，且 OpenProcess 后必须 CloseHandle，否则句柄泄漏。
const FOCUS_SCRIPT = [
  'import ctypes, sys, os',
  'try:',
  '    u = ctypes.windll.user32; k = ctypes.windll.kernel32',
  '    u.GetForegroundWindow.restype = ctypes.c_void_p',
  '    u.GetForegroundWindow.argtypes = []',
  '    u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]',
  '    u.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]',
  '    u.GetWindowTextLengthW.restype = ctypes.c_int',
  '    u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]',
  '    k.OpenProcess.restype = ctypes.c_void_p',
  '    k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]',
  '    k.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]',
  '    k.CloseHandle.argtypes = [ctypes.c_void_p]',
  '    hwnd = u.GetForegroundWindow()',
  '    if not hwnd:',
  "        print('0'); sys.exit(0)",
  '    pid = ctypes.c_ulong()',
  '    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))',
  '    h = k.OpenProcess(0x1000, False, pid.value)',
  '    if not h:',
  "        print('0'); sys.exit(0)",
  '    try:',
  '        buf = ctypes.create_unicode_buffer(32768); size = ctypes.c_ulong(32768)',
  '        ok = k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))',
  "        exe = os.path.basename(buf.value) if ok else ''",
  '    finally:',
  '        k.CloseHandle(h)',
  '    n = u.GetWindowTextLengthW(hwnd)',
  '    tbuf = ctypes.create_unicode_buffer(n + 1)',
  '    u.GetWindowTextW(hwnd, tbuf, n + 1)',
  '    title = tbuf.value',
  "    hit = exe.lower() == 'deepseek harness.exe' or title.lower().startswith('dsh-pet')",
  "    print('1' if hit else '0')",
  'except Exception:',
  "    print('0')",
].join('\n');

// 正规接口：直接复用 see-now 自己的 findListenPython——它统一处理 DSH_SEE_PYTHON /
// DSH_FLOAT_PYTHON / see-window.json / PATH 的优先级，并实际探测解释器能否启动。
// 这样 see-now 改了查找规则，本插件自动跟随；不再自己读 see-window.json 猜路径。
let findListenPython = null;
let cachedPython;
function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  let py = null;
  try { py = findListenPython?.() ?? null; } catch { /* 探测失败走回退 */ }
  cachedPython = py || (platform() === 'win32' ? 'python' : 'python3');
  return cachedPython;
}

/**
 * 前台窗口是不是 DSH（主程序或桌宠）。非 Windows 优雅降级为 false（不暂停）。
 * spawn 没有 timeout 选项，用 setTimeout kill 并只 resolve 一次。
 */
async function checkDshFocus() {
  if (platform() !== 'win32') return false;
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let child;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(resolvePython(), ['-c', FOCUS_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      log(`focus detect spawn failed: ${e.message}`);
      return resolve(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } done(false); }, 2000);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => done(false));
    child.on('close', () => done(out.trim().split(/\r?\n/).pop()?.trim() === '1'));
  });
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

// see-now 的设置读取器：与它自己的设置页共用同一份校验逻辑。
// `dsh-see-now` 的 exports 没有暴露 `./tuning`，所以从包根定位 `src/tuning.js`。
// 缺失时退回只读 see-now.json 的旧路径（至少 pace / fps 仍可用）。
let readSeeNowTuning = null;
try {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('dsh-see-now/package.json');
  ({ readTuning: readSeeNowTuning } = await import(
    pathToFileURL(join(dirname(pkg), 'src', 'tuning.js')).href
  ));
} catch (e) {
  log(`tuning reader unavailable (${e.message}); only defaultPace/fps will follow see-now`);
}

// see-now 的 listener（音频采集 + 转写调度）同样不在 exports 里，从包根深路径导入。
// 导入失败只关掉听音功能，不影响抓屏。
// 转写完全交给 listener 自己：它内部用 see-now 的 resolveTranscriber，
// 读取 see-now 设置页的 prefer / live / silence 等以及 ~/.dsh/asr.json，本插件不另做识别配置。
let createListener = null;
let LISTEN_DEFAULTS = null;
try {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('dsh-see-now/package.json');
  ({ createListener, findListenPython } = await import(
    pathToFileURL(join(dirname(pkg), 'src', 'listen.js')).href
  ));
  ({ LISTEN_DEFAULTS } = await import(
    pathToFileURL(join(dirname(pkg), 'src', 'tuning.js')).href
  ));
} catch (e) {
  log(`listener unavailable (${e.message}); audio listening disabled`);
}

/** 读本插件自己的设置：语音识别开关与 DSH 聚焦暂停。 */
function readPetSeeConfig() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(PET_SEE_CFG, 'utf8')); } catch { /* 用默认 */ }
  return {
    listenEnabled: raw.listenEnabled === true,
    pauseOnFocus: raw.pauseOnFocus !== false,   // 默认开启
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
let webServer = null;

/** pet 是否在：端口可达即 pet 开着（跨平台，不查进程）。 */
async function checkPet(ctx) {
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

/** 挂设置页用的同源 HTTP API：GET /status、POST /config。 */
function installSettingsApi(ctx) {
  if (!ctx?.inject) return;
  try {
    ctx.inject(['webServer'], (scoped) => {
      webServer = scoped.webServer;   // 捕获 DSH 注入的 webServer，供 checkPet 读取端口
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix', path: API_PREFIX, auth: 'required',
        handler: (req, res) => { void handleSettingsRequest(req, res); },
      }, 'dsh-pet-see-live: settings routes'));
    });
  } catch (e) {
    log(`settings API unavailable: ${e.message}`);
  }
}

async function handleSettingsRequest(req, res) {
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
      if (bad || Object.keys(patch).length === 0) {
        send(400, { ok: false, reason: 'bad-config' });
        return;
      }
      writePetSeeConfig(patch);
      send(200, { ok: true, ...readPetSeeConfig() });
      return;
    }
    send(404, { ok: false, reason: 'not-found' });
  } catch (e) {
    send(500, { ok: false, reason: e.message });
  }
}

/**
 * 把 see-now 图集的帧清单写成 pet 能读懂的时间顺序说明。
 *
 * 图里每格虽然烧了编号，但只发 PNG 的话模型不知道编号代表什么；
 * see-now 原本会在工具文本里附带 frame@时间码，这里补上同一份信息。
 */
function sheetPrompt(sheet) {
  const frames = Array.isArray(sheet?.frames) ? sheet.frames : [];
  const lines = linesBlock(sheet?.lines);
  if (frames.length < 2) {
    return '看一眼我现在的屏幕，用简短一句话吐槽或评价，不超过20字。' + lines;
  }
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

/** 把一张图喂给 pet（Node 原生 fetch，无 curl 依赖）。externalSignal 用于失焦时取消在途请求。 */
async function postImage(base, sheet, externalSignal) {
  const payload = JSON.stringify({
    text: sheetPrompt(sheet),
    attachment: { mediaType: 'image/png', data: sheet.png.toString('base64') },
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
  const { listenEnabled, pauseOnFocus } = readPetSeeConfig();
  const quality = DEFAULT_QUALITY || 'low';
  const [width, height] = SIZES[quality];
  const wakeGapMs = p.wakeGapSec * 1000;   // see-now 自己的"多久叫醒一次"
  const ffmpegPath = resolveFfmpeg();
  log(
    `apply: pace=${pace} fps=${fps} ${width}x${height} quality=${quality}`
      + ` listen=${listenEnabled && createListener ? 'on' : 'off'} pauseOnFocus=${pauseOnFocus}`
      + ` wakeGap=${wakeGapMs}ms`
      + ` tier=${tuning ? `${tuning.tierStyle}/${tuning.tierMode}/${tuning.tierCurve}` : 'defaults'}`
      + ` ffmpeg=${ffmpegPath}`,
  );
  installSettingsApi(ctx);

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
  let lastFocusCheck = 0;
  let focusCheckInFlight = false;
  // 听音细节全部沿用 see-now：listen 段直接来自它的 tuning（prefer / live / silence / maxSeg…）
  const listenCfg = {
    ...(LISTEN_DEFAULTS || {}),
    ...(tuning?.listen ?? {}),
  };

  const canRun = () => petAlive && !dshFocused && !disposed;

  // 出图参数全部来自 see-now：pace 管 cutAbs / 兜底节奏，设置页的档位参数走 tuning
  const pipeline = createPipeline({
    width, height, fps,
    cutAbs: p.cutAbs,
    ...p.pipeline,
    ...pipelineTuningOf(tuning),
  });

  function startCapture() {
    if (captureOn || disposed || dshFocused) return;
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
      const { status, body } = await postImage(petBase, sheet, ac.signal);
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
      // 焦点检查放最前，且与 checkPet 并发，避免慢查询延迟暂停
      const focusP = (pauseOnFocus && now - lastFocusCheck >= 2000 && !focusCheckInFlight)
        ? (() => { lastFocusCheck = now; focusCheckInFlight = true; return checkDshFocus(); })()
        : null;
      const petP = (now - lastPetCheck >= 2000) ? checkPet(ctx) : null;
      const [focused, pet] = await Promise.all([
        focusP ?? Promise.resolve(null),
        petP ?? Promise.resolve(null),
      ]);
      if (focusCheckInFlight && focusP) {
        focusCheckInFlight = false;
        if (focused !== null) setFocused(focused);
      }
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
          pendingSheet = s; void drain();
        }
      } catch (e) { log(`take ERR: ${e.message}`); }
      void drain();
    } finally { inTick = false; }
  }

  // 初始化：先读焦点与 pet 状态，再决定是否启动；最后才注册定时器，避免首个 tick 竞态。
  if (pauseOnFocus) dshFocused = await checkDshFocus();
  const init = await checkPet(ctx);
  petAlive = init.up; petBase = init.base;
  lastPetCheck = Date.now(); lastFocusCheck = Date.now();
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
