#!/usr/bin/env node
/**
 * 开发用启动器：不经过 DSH 宿主，直接把桌面宠物助手拉起来。
 *
 * 用法：
 *   node scripts/start-helper.mjs                        # 用默认形象起一只
 *   node scripts/start-helper.mjs --species policegirl   # 指定形象
 *   node scripts/start-helper.mjs --switch-after 6 policegirl   # 6 秒后走命令通道换皮（验证切换链路）
 *   node scripts/start-helper.mjs --dsh-pid 12345        # 指定「唤起 DSH」的目标进程
 *
 * 为什么要它：宿主半侧还没写完，而桌面窗这块必须能独立验证。
 * 正式运行时由宿主 spawn 同样的 main.js，并注入 DSH_DESKPET_CONFIG_JSON。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HELPER = path.join(ROOT, 'runtime', 'electron-helper', 'main.js');

function parseArgs(argv) {
  const out = { species: null, switchAfter: 0, switchTo: null, dshPid: 0, dshExe: '', orphanAfter: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--species') out.species = argv[++i];
    else if (a === '--switch-after') {
      out.switchAfter = Number(argv[++i]) || 0;
      out.switchTo = argv[++i] || null;
    } else if (a === '--dsh-pid') out.dshPid = Number(argv[++i]) || 0;
    else if (a === '--dsh-exe') out.dshExe = argv[++i] || '';
    // 调试用：把宿主 pid 设成一个不存在的进程，立即验证「孤儿模式 + 点击启动」
    else if (a === '--orphan-after') out.orphanAfter = Number(argv[++i]) || 0;
  }
  return out;
}

/** 找 Electron：优先环境变量，其次 dsh-pet 已经下载好的那份 */
function findElectron() {
  const candidates = [
    process.env.DSH_DESKPET_ELECTRON_PATH,
    path.join(os.homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到 Electron，可用 DSH_DESKPET_ELECTRON_PATH 指定');
}

/** 找到 DSH 主进程（Electron 主窗口那个），用于「点击宠物唤起 DSH」 */
function guessDshPid() {
  if (process.env.DSH_DESKPET_DSH_PID) return Number(process.env.DSH_DESKPET_DSH_PID) || 0;
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const electron = findElectron();
const logFile = path.join(os.tmpdir(), 'deskpet-helper.log');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键：不删掉它，Electron 会以纯 Node 模式启动，require('electron') 直接失败
env.DSH_DESKPET_LOG = logFile;
env.DSH_DESKPET_USER_ROOT = path.join(os.homedir(), '.dsh', 'dsh-deskpet');
const dshPid = args.dshPid || guessDshPid();
if (dshPid) env.DSH_DESKPET_DSH_PID = String(dshPid);
const dshExe = args.dshExe || process.env.DSH_DESKPET_DSH_EXE || '';
if (dshExe) env.DSH_DESKPET_DSH_EXE = dshExe;
// 开发态把「宿主」当成这个启动器自己：它一退出，宠物就转孤儿模式（和正式运行一致）
env.DSH_DESKPET_HOST_PID = args.orphanAfter > 0 ? '999999' : String(process.pid);
if (args.species) {
  env.DSH_DESKPET_CONFIG_JSON = JSON.stringify({ pets: [{ id: 'main', species: args.species }] });
}

console.log(`[dev] electron = ${electron}`);
console.log(`[dev] helper   = ${HELPER}`);
console.log(`[dev] log      = ${logFile}`);
console.log(`[dev] dsh pid  = ${dshPid || '(未指定，点击宠物不会唤起 DSH)'}`);
console.log(`[dev] dsh exe  = ${dshExe || '(未指定，DSH 退出后无法自动启动)'}`);

// detached + unref：Windows 上只有这样才能让宠物在启动器退出后继续活着（和正式宿主一致）
const child = spawn(electron, [HELPER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
child.unref();

let stdoutBuf = '';
let callbackUrl = null;
child.stdout.on('data', (d) => {
  process.stdout.write(`[helper] ${d}`);
  stdoutBuf += String(d);
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.startsWith('{')) continue; // 非 JSON 行 = helper 的日志
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'ready' && msg.callback) {
        callbackUrl = msg.callback;
        console.log(`[dev] 命令通道：${callbackUrl}`);
        if (args.switchAfter > 0 && args.switchTo) {
          setTimeout(() => switchSpecies(args.switchTo), args.switchAfter * 1000);
        }
      }
    } catch {
      /* 日志行，忽略 */
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[helper:err] ${d}`));
child.on('exit', (code) => {
  console.log(`[dev] helper 退出，code=${code}`);
  process.exit(code ?? 0);
});

/** 走真实命令通道换皮（和宿主用的是同一条路径） */
async function switchSpecies(species) {
  if (!callbackUrl) {
    console.error('[dev] 还没拿到命令通道地址，换皮失败');
    return;
  }
  console.log(`[dev] 换皮 -> ${species}`);
  try {
    const res = await fetch(`${callbackUrl}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'setSpecies', pet: 'main', species }),
    });
    console.log(`[dev] 换皮响应 HTTP ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error('[dev] 换皮请求失败：', err.message);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill());
}
