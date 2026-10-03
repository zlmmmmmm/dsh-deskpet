#!/usr/bin/env node
/**
 * 把本插件装进 / 卸出某个 DSH profile。
 *
 * 为什么不用 `dsh plugin add`：本机 `dsh` 不在 PATH 上（DSH 是桌面客户端形态安装的），
 * 而 profile 层其实就两件事——package.json 的 dependencies 加一条 file: 依赖、
 * dsh.profile.bundles 加一个 bundle 名，然后 pnpm install。这个脚本把它们做全，
 * 并在改动前备份 package.json。
 *
 * 用法：
 *   node scripts/install-into-profile.mjs                # 装进 desktop profile
 *   node scripts/install-into-profile.mjs --profile web  # 指定 profile
 *   node scripts/install-into-profile.mjs --remove       # 卸载
 *   node scripts/install-into-profile.mjs --dry-run      # 只看会改什么
 *
 * ⚠️ 装完必须重启 DSH 才生效（插件层在启动时构建配置树）。重启会结束当前会话。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const PKG_NAME = 'dsh-deskpet';

function parseArgs(argv) {
  const out = { profile: 'desktop', remove: false, dryRun: false, disable: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i] ?? 'desktop';
    else if (a === '--remove') out.remove = true;
    else if (a === '--dry-run') out.dryRun = true;
    // --disable a,b：把别的桌宠插件从 bundle 列表里摘掉（不同时画两只）。
    // 只动 bundles，保留 dependencies，所以想恢复只需把名字加回 bundles。
    else if (a === '--disable') out.disable.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** pnpm 的落地路径：优先环境变量，其次 DSH 自带运行时 */
function pnpmCommand() {
  const candidates = [
    process.env.DSH_PNPM_PATH,
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return { node: process.execPath, script: c };
  return null;
}

const args = parseArgs(process.argv.slice(2));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', args.profile);
const pkgFile = join(profileDir, 'package.json');

if (!existsSync(pkgFile)) {
  console.error(`找不到 profile：${pkgFile}`);
  process.exit(1);
}

const raw = readFileSync(pkgFile, 'utf8');
const pkg = JSON.parse(raw);
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
const bundles = pkg.dsh.profile.bundles;

// 用 file:（拷贝）。
// 为什么不用 link:：pnpm 处理这两种写法都要**替换** node_modules 下那个路径，
// 而 DSH 一旦加载过插件，那个目录就被进程占着，替换必然 EPERM（实测）。
// 所以本脚本在目录已存在时改成「就地覆盖文件」——不替换目录，绕开占用锁，
// 于是插件正在运行时也能安全更新（新代码在下次重启后生效）。
const spec = `file:${PKG_ROOT.replace(/\\/g, '/')}`;
/** profile 里的落地目录 */
const installedDir = join(profileDir, 'node_modules', PKG_NAME);
/** 需要同步过去的文件/目录 */
const PAYLOAD = ['lib', 'runtime', 'assets', 'cordis.patch.yml', 'package.json'];

if (args.remove) {
  delete pkg.dependencies[PKG_NAME];
  pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME);
  console.log(`[uninstall] 从 ${pkgFile} 移除 ${PKG_NAME}`);
} else {
  pkg.dependencies[PKG_NAME] = spec;
  if (!bundles.includes(PKG_NAME)) {
    // 放在官方基础 bundle 之后、其它第三方插件之前（顺序不影响职责，只为可读）
    const at = bundles.findIndex((b) => !String(b).startsWith('@deepseek-ai/'));
    bundles.splice(at < 0 ? bundles.length : at, 0, PKG_NAME);
  }
  console.log(`[install] ${PKG_NAME} → ${spec}`);
}

// 停用其它桌宠插件：只从 bundles 摘掉（依赖保留），避免重启后同时画两只宠物
if (args.disable.length) {
  const before = pkg.dsh.profile.bundles;
  const kept = before.filter((b) => !args.disable.includes(String(b)));
  for (const name of args.disable) {
    if (before.includes(name)) console.log(`[disable] 从 bundles 摘掉 ${name}（依赖与文件都保留，想恢复把名字加回 bundles 即可）`);
    else if (!kept.includes(name)) console.log(`[disable] ${name} 本来就不在 bundles 里`);
  }
  pkg.dsh.profile.bundles = kept;
}
console.log(`[bundles] ${pkg.dsh.profile.bundles.join(', ')}`);

const next = JSON.stringify(pkg, null, 2) + '\n';
if (args.dryRun) {
  console.log('--- dry-run，未写入 ---');
  console.log(next);
  process.exit(0);
}

const backup = `${pkgFile}.bak-${Date.now()}`;
copyFileSync(pkgFile, backup);
writeFileSync(pkgFile, next, 'utf8');
console.log(`[ok] 已写入 ${pkgFile}\n[ok] 备份 ${backup}`);

const pnpm = pnpmCommand();

if (!existsSync(installedDir)) {
  // 第一次装：交给 pnpm（它要把依赖写进 lockfile、建目录）
  if (!pnpm) {
    console.warn('[warn] 没找到 pnpm，请手工在 profile 目录执行一次 pnpm install');
    process.exit(0);
  }
  console.log('[..] 首次安装，正在执行 pnpm install…');
  const r = spawnSync(pnpm.node, [pnpm.script, 'install'], { cwd: profileDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[err] pnpm install 失败，可恢复备份：');
    console.error(`      copy "${backup}" "${pkgFile}"`);
    process.exit(r.status ?? 1);
  }
} else {
  // 已装过：**就地覆盖文件**，不替换目录。
  // 原因：DSH 加载过插件后那个目录被占用，pnpm 替换它会 EPERM（实测），
  // 而且 pnpm 还会因为版本号没变而直接 "Already up to date" 跳过更新 —— 那会
  // 让你改了源码却一直跑旧副本。就地拷贝两个问题一起解决。
  console.log('[..] 目录已存在，就地覆盖文件（不替换目录，插件正在运行也能更新）…');
  for (const item of PAYLOAD) {
    const s = join(PKG_ROOT, item);
    if (!existsSync(s)) continue;
    try {
      cpSync(s, join(installedDir, item), { recursive: true, force: true });
    } catch (err) {
      console.error(`[err] 覆盖 ${item} 失败：${err.message}`);
      process.exit(1);
    }
  }
}

// 装完必须校验：profile 里那份产物和源码是不是同一份内容。
// pnpm 会安静地"Already up to date"然后让你跑几小时的旧代码，这个兜底值一条命令。
const srcEntry = join(PKG_ROOT, 'lib', 'index.js');
const dstEntry = join(installedDir, 'lib', 'index.js');
try {
  const src = createHash('sha256').update(readFileSync(srcEntry)).digest('hex');
  const dst = createHash('sha256').update(readFileSync(dstEntry)).digest('hex');
  if (src === dst) {
    console.log(`[ok] 校验通过：profile 里的产物与源码一致（${src.slice(0, 12)}…）`);
  } else {
    console.error('[err] 校验失败：profile 里的产物和源码不一致！');
    console.error(`      源码 ${srcEntry}\n      副本 ${dstEntry}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[err] 校验读不到文件：${err.message}`);
  process.exit(1);
}

console.log(`\n完成。下一步：重启 DeepSeek Harness（插件层在启动时构建，重启后宠物才会出现）。`);
console.log(`宠物用户数据目录：${join(dshHome, PKG_NAME)}`);
