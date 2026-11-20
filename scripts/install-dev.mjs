#!/usr/bin/env node
/**
 * 源码安装：把本插件拷进 DSH 的 desktop profile 并登记 bundle。
 *
 *   node scripts/install-dev.mjs
 *
 * 用 --check 只检查不改动；用 --profile <name> 指定 profile（默认 desktop）。
 * 这是"复制"不是软链——Node 解析裸包名要走真实路径才能找到 see-now。
 * 装完重启 DSH 生效。
 */
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const profileArg = args.indexOf('--profile');
const PROFILE = profileArg >= 0 ? args[profileArg + 1] : 'desktop';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = join(HOME, 'profiles', PROFILE);
const PKG_PATH = join(PROFILE_DIR, 'package.json');
const DEST = join(PROFILE_DIR, 'node_modules', 'dsh-pet-see-live');

function fail(msg) {
  console.error(`[install-dev] ${msg}`);
  process.exitCode = 1;
}

if (!existsSync(PKG_PATH)) {
  fail(`profile not found: ${PKG_PATH} (先启动一次 DSH 桌面端初始化该 profile)`);
} else {
  const raw = readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.dsh ||= {};
  pkg.dsh.profile ||= {};
  pkg.dsh.profile.bundles ||= [];
  pkg.dependencies ||= {};

  const changed = [];
  if (!pkg.dsh.profile.bundles.includes('dsh-pet-see-live')) {
    pkg.dsh.profile.bundles.push('dsh-pet-see-live');
    changed.push('bundles += dsh-pet-see-live');
  }
  if (pkg.dependencies['dsh-pet-see-live'] !== '0.1.0') {
    pkg.dependencies['dsh-pet-see-live'] = '0.1.0';
    changed.push('dependencies.dsh-pet-see-live = 0.1.0');
  }

  if (checkOnly) {
    console.log(`[install-dev] check: profile=${PROFILE_DIR}`);
    console.log(`[install-dev] dest=${DEST}`);
    console.log(changed.length ? `pending: ${changed.join('; ')}` : 'already registered');
  } else {
    mkdirSync(dirname(DEST), { recursive: true });
    cpSync(ROOT, DEST, { recursive: true, force: true, filter: (src) => !src.includes(`${join('node_modules')}`) });
    writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[install-dev] installed to ${DEST}`);
    console.log(`[install-dev] profile updated: ${changed.join('; ') || 'already registered'}`);
    console.log('[install-dev] 重启 DSH 生效。日志：~/.dsh/dsh-pet/see-live-plugin.log');
  }
}
