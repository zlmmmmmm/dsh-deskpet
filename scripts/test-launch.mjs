#!/usr/bin/env node
/**
 * 「点击宠物」动作的分支自测。
 *
 * 覆盖：
 *   located / would-launch   —— 预演模式（不抢焦点、不启动），安全
 *   focused                  —— 真去聚焦当前 DSH 窗口（会抢焦点，可 --allow-focus 打开）
 *   launched                 —— 真的 Start-Process 一个替身脚本，用它写出的标记文件作证
 *   no-exe / bad-exe         —— 找不到安装位置/路径不对时的兜底
 *
 * 用法：node scripts/test-launch.mjs [--allow-focus]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { locateOrLaunch } = require('../runtime/electron-helper/focus-dsh.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const allowFocus = process.argv.includes('--allow-focus');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name} —— ${err.message}`);
    fail++;
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** 当前 DSH 主窗口进程 pid（拿不到就跳过相关用例） */
function findDshPid() {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1).Id",
    ],
    { encoding: 'utf8' },
  );
  const pid = Number(String(ps.stdout).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

const dshPid = findDshPid();
console.log(`当前 DSH 主窗口 pid = ${dshPid || '(没找到)'}`);

// 替身启动器：写一个标记文件，用来证明 Start-Process 真的执行了
const marker = join(tmpdir(), 'deskpet-launch-proof.txt');
const stub = join(tmpdir(), 'deskpet-launch-stub.cmd');
rmSync(marker, { force: true });
writeFileSync(stub, `@echo off\r\necho launched > "${marker}"\r\n`, 'utf8');

console.log('\n分支测试：');

// 用一个**不存在的进程名**来做"DSH 已经退出"的场景：
// 直接拿真名测会被"按进程名兜底"正确地找到正在运行的 DSH（那是另一条用例）。
const ABSENT = 'DeskpetNoSuchProcess12345';

await check('DSH 没运行 + 给了启动器 + 预演 → would-launch（不真的启动）', async () => {
  const r = await locateOrLaunch({ pid: 999999, dryRun: true, launchExe: stub, processName: ABSENT });
  assert(r.action === 'would-launch', `得到 ${r.action}`);
  assert(!existsSync(marker), '预演模式竟然真的启动了');
});

await check('DSH 没运行 + 真启动替身脚本 → launched，且标记文件出现', async () => {
  const r = await locateOrLaunch({ pid: 999999, launchExe: stub, processName: ABSENT });
  assert(r.action === 'launched', `得到 ${r.action}`);
  // Start-Process 是异步的，等一下标记文件
  for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((res) => setTimeout(res, 100));
  assert(existsSync(marker), 'Start-Process 没有产生标记文件');
  assert(readFileSync(marker, 'utf8').includes('launched'), '标记文件内容不对');
});

await check('DSH 没运行 + 没给启动器 → no-exe', async () => {
  const r = await locateOrLaunch({ pid: 999999, launchExe: '', processName: ABSENT });
  assert(r.action === 'no-exe', `得到 ${r.action}`);
});

await check('DSH 没运行 + 启动器路径不存在 → bad-exe', async () => {
  const r = await locateOrLaunch({ pid: 999999, launchExe: join(tmpdir(), 'nope-does-not-exist.exe'), processName: ABSENT });
  assert(r.action === 'bad-exe', `得到 ${r.action}`);
});

if (dshPid) {
  await check('按 pid 定位当前 DSH 窗口（预演，不抢焦点）', async () => {
    const r = await locateOrLaunch({ pid: dshPid, dryRun: true });
    assert(r.action === 'located', `得到 ${r.action}`);
    assert(r.hwnd > 0, '没拿到 hwnd');
    assert(r.foundPid === dshPid, `foundPid=${r.foundPid}`);
  });

  await check('pid 过期时按进程名兜底到真正的 DSH 窗口（预演）', async () => {
    const r = await locateOrLaunch({ pid: 999999, dryRun: true });
    assert(r.action === 'located', `得到 ${r.action}（应该靠进程名兜底到 ${dshPid}）`);
    assert(r.foundPid === dshPid, `兜底到 ${r.foundPid}`);
  });

  await check('DSH 在运行 → 即使给了启动器也不会去启动（不会开出第二个实例）', async () => {
    rmSync(marker, { force: true }); // 上一条用例留下的标记必须清掉，否则是假阳性
    const r = await locateOrLaunch({ pid: dshPid, dryRun: true, launchExe: stub });
    assert(r.action === 'located', `得到 ${r.action}`);
    await new Promise((res) => setTimeout(res, 600)); // Start-Process 是异步的，给足时间让假阳性暴露
    assert(!existsSync(marker), 'DSH 明明在运行，却去启动了一个新实例');
  });

  if (allowFocus) {
    await check('真聚焦当前 DSH 窗口 → focused', async () => {
      const r = await locateOrLaunch({ pid: dshPid });
      assert(r.action === 'focused', `得到 ${r.action}`);
    });
  } else {
    console.log('  · 跳过「真聚焦」用例（加 --allow-focus 打开，会抢焦点）');
  }
}

rmSync(stub, { force: true });
rmSync(marker, { force: true });

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
