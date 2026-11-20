#!/usr/bin/env node
/**
 * 源码安装：把本插件复制进 DSH 的 desktop profile 并登记 bundle。
 *
 *   node scripts/install-dev.mjs            # 安装 / 同步
 *   node scripts/install-dev.mjs --check    # 只看状态不改
 *   node scripts/install-dev.mjs --remove   # 卸载
 *
 * 为什么不用 dsh plugin add：desktop profile 由 DSH 桌面端独占管理，
 * `dsh plugin --profile desktop ...` 会被拒绝（"managed exclusively by the Electron application"）。
 *
 * 为什么用复制不是软链：Node 解析裸包名要走真实路径才能找到同级的 dsh-see-now。
 * 装完重启 DSH 生效。可用 DSH_PROFILE 指定其它 profile。
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

// 这些目录不复制（避免把 git 历史 / 依赖 / 临时文件带进去）
const SKIP = new Set(['node_modules', '.git', 'test', '.tmp', 'scripts', 'debug']);

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check' : 'install';

if (!existsSync(PROFILE_DIR)) {
  console.error(`[install-dev] profile 不存在：${PROFILE_DIR}（先启动一次 DSH 桌面端初始化该 profile）`);
  process.exit(2);
}

const pkgPath = join(PROFILE_DIR, 'package.json');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function editProfile({ add }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasDep = Object.hasOwn(pkg.dependencies ?? {}, PKG_NAME);

  if (add) {
    if (!hasDep) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(PROFILE_DIR, `package.json.bak-${stamp}-presee-live`);
      await writeFile(backup, await readFile(pkgPath));
      console.log(`[install-dev] 已备份 package.json → ${backup}`);
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: `file:${ROOT.replace(/\\/g, '/')}` };
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    if (!bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles = [...bundles, PKG_NAME];
  } else {
    if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
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
  console.log('[install-dev] 已卸载，重启 DSH 生效。');
  await report();
  process.exit(0);
}

await rm(DEST, { recursive: true, force: true });
await cp(ROOT, DEST, { recursive: true, filter: (s) => !SKIP.has(s.split(/[\\/]/).pop()) });
await editProfile({ add: true });
console.log('[install-dev] 已安装，重启 DSH 生效。日志：~/.dsh/dsh-pet/see-live-plugin.log');
await report();
