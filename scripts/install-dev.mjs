#!/usr/bin/env node
/**
 * 源码安装：把本插件复制进 DSH 的 desktop profile 并登记 bundle。
 *
 *   node scripts/install-dev.mjs            # 安装 / 同步
 *   node scripts/install-dev.mjs --check    # 只看状态不改
 *   node scripts/install-dev.mjs --remove   # 卸载（保留设置/日志）
 *   node scripts/install-dev.mjs --remove --purge  # 卸载并清理本插件设置/日志/音频
 *
 * 为什么不用 dsh plugin add：desktop profile 由 DSH 桌面端独占管理，
 * `dsh plugin --profile desktop ...` 会被拒绝（"managed exclusively by the Electron application"）。
 *
 * 为什么用复制不是软链：Node 解析裸包名要走真实路径才能找到同级的 dsh-see-now。
 * 源码安装不写 profile 的 dependencies / pnpm-lock：桌面 profile 的包管理归 Electron，
 * 手写 file: 依赖会在源码目录移动/删除或 frozen install 时留下垃圾。插件只靠
 * node_modules 副本 + dsh.profile.bundles 加载；旧版本留下的依赖和 lockfile 条目会在
 * 安装/卸载时清掉。装完重启 DSH 生效。可用 DSH_PROFILE 指定其它 profile。
 */
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const MODULES = join(PROFILE_DIR, 'node_modules');
const PKG_NAME = 'dsh-pet-see-live';
const DEST = join(MODULES, PKG_NAME);
const BACKUP = join(PROFILE_DIR, 'package.json.bak-presee-live');
const PET_DIR = join(DSH_HOME, 'dsh-pet');
const PET_SEE_CFG = join(DSH_HOME, 'pet-see-live.json');
const SELF_LOG = join(PET_DIR, 'see-live-plugin.log');
const AUDIO_DIR = join(PET_DIR, 'see-live-audio');

// 这些目录不复制（避免把 git 历史 / 依赖 / 临时文件带进去）
const SKIP = new Set(['node_modules', '.git', 'test', '.tmp', 'scripts', 'debug']);

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check' : 'install';
const purge = process.argv.includes('--purge');

if (mode !== 'remove' && purge) {
  console.error('[install-dev] --purge 只能和 --remove 一起用');
  process.exit(2);
}

if (!existsSync(PROFILE_DIR)) {
  console.error(`[install-dev] profile 不存在：${PROFILE_DIR}（先启动一次 DSH 桌面端初始化该 profile）`);
  process.exit(2);
}

const pkgPath = join(PROFILE_DIR, 'package.json');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function editProfile({ add }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];

  if (add && !existsSync(BACKUP)) {
    await writeFile(BACKUP, await readFile(pkgPath));
    console.log(`[install-dev] 已备份 package.json → ${BACKUP}`);
  }

  // 源码安装不再写 profile 依赖；顺手清掉旧版本留下的 file: 依赖。
  if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  if (add) {
    if (!bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles = [...bundles, PKG_NAME];
  } else if (pkg.dsh?.profile?.bundles) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/** 删掉一个 YAML 映射块（key 行 + 其下更深缩进的行）；返回新行数组。 */
function removeYamlBlock(lines, keyPattern, indent) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && keyPattern.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === '') continue;
      const lead = line.match(/^ */)?.[0].length ?? 0;
      if (lead <= indent) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

/** 清掉 pnpm-lock 里旧源码安装留下的 dsh-pet-see-live 条目。 */
async function cleanLockfile() {
  const lockPath = join(PROFILE_DIR, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return false;
  const before = await readFile(lockPath, 'utf8');
  let lines = before.split(/\r?\n/);
  // importer 依赖块（6 空格）以及 packages/snapshots 的顶层键（2 空格）
  lines = removeYamlBlock(lines, /^ {6}dsh-pet-see-live:\s*$/, 6);
  lines = removeYamlBlock(lines, /^ {2}dsh-pet-see-live@/, 2);
  const after = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  if (after === before) return false;
  await writeFile(lockPath, after, 'utf8');
  return true;
}

async function purgePluginData() {
  await rm(PET_SEE_CFG, { force: true });
  await rm(SELF_LOG, { force: true });
  await rm(AUDIO_DIR, { recursive: true, force: true });
}

async function report() {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const installed = existsSync(DEST);
  const registered = bundles.includes(PKG_NAME);
  console.log(`[install-dev] profile : ${PROFILE_DIR}`);
  console.log(`[install-dev] ${PKG_NAME}: ${installed ? '已安装' : '未安装'}，bundle ${registered ? '已注册' : '未注册'}`);
  console.log(`[install-dev] bundles 共 ${bundles.length} 项：${bundles.join(', ')}`);

  const repoVersion = (await readJson(join(ROOT, 'package.json'))).version;
  if (installed) {
    const copyVersion = await readJson(join(DEST, 'package.json')).then((p) => p.version).catch(() => null);
    console.log(`[install-dev] 源版本  : ${repoVersion}`);
    console.log(`[install-dev] 安装版本: ${copyVersion ?? '未知'}${copyVersion === repoVersion ? '  ✓ 一致' : '  ⚠ 与源不一致（可能加载到旧代码）'}`);
    if (copyVersion !== repoVersion) {
      console.log('\n  提示：运行 `node scripts/install-dev.mjs` 同步，然后**重启 DSH**；旧会话里加载的工具不会刷新。');
    }
  }
  return { installed, registered };
}

if (mode === 'check') { await report(); process.exit(0); }

if (mode === 'remove') {
  await rm(DEST, { recursive: true, force: true });
  await editProfile({ add: false });
  const lockCleaned = await cleanLockfile();
  if (lockCleaned) console.log('[install-dev] 已清理 pnpm-lock.yaml 里的旧 dsh-pet-see-live 条目');
  if (purge) {
    await purgePluginData();
    console.log('[install-dev] 已清理本插件设置 / 日志 / 音频');
  }
  console.log('[install-dev] 已卸载，重启 DSH 生效。');
  await report();
  process.exit(0);
}

await rm(DEST, { recursive: true, force: true });
await cp(ROOT, DEST, { recursive: true, filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()) });
await editProfile({ add: true });
const lockCleaned = await cleanLockfile();
if (lockCleaned) console.log('[install-dev] 已清理 pnpm-lock.yaml 里的旧 dsh-pet-see-live 条目');
console.log('[install-dev] 已安装（源码安装不写 profile 依赖），重启 DSH 生效。日志：~/.dsh/dsh-pet/see-live-plugin.log');
await report();
