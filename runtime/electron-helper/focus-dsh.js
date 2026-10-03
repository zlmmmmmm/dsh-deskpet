'use strict';
/**
 * 「点击宠物」的动作：把 DeepSeek Harness 叫回前台；**如果它已经退出了，就把它启动起来**。
 *
 * 为什么要走 PowerShell：Electron 主进程没有 Win32 绑定，而引入 ffi（koffi 等）
 * 会多一个原生依赖。这是低频动作（点一下才发生），spawn 一个 powershell 用
 * Add-Type 调 user32，实测延迟几百毫秒，够用且零原生依赖。
 *
 * 窗口定位两级，缺一不可：
 *   1. 按 pid 精确匹配 —— pid 由宿主注入（DSH 主窗口进程 = 插件宿主进程的父进程，进程树实测过）
 *   2. 按进程名兜底 —— pid 会过期：DSH 重启后宠物还活着时，手里那个 pid 已经是旧进程了
 *
 * 启动判据很保守：**只有整机上一个 "DeepSeek Harness" 进程都没有时才启动**。
 * 否则「最小化到托盘 / 暂时没有可见窗口」这类情况会被误判成"已退出"，拉起第二个实例。
 *
 * 前台权限：Windows 只允许「当前前台进程」改前台窗口。用户是**点了宠物**才触发的，
 * 此时本进程正是前台进程，所以 SetForegroundWindow 能成功。
 */
const { spawn } = require('node:child_process');

/** DSH 桌面客户端的进程名（不含 .exe）；可用 DSH_DESKPET_DSH_PROCESS 覆盖 */
const TARGET_PROCESS_NAME = 'DeepSeek Harness';

/** 结果行前缀：stdout 里可能还有 PowerShell 的其它输出，靠它定位 */
const RESULT_MARK = 'DSHPET_RESULT:';

/**
 * 生成 PowerShell 脚本。
 * @param {number} targetPid 优先匹配的 pid；<=0 表示只用进程名
 * @param {boolean} doFocus false = 只定位/只预演，不抢焦点、不真的启动
 * @param {string} launchExe 找不到运行中的 DSH 时用它启动（空 = 不启动）
 * @param {string} processName 目标进程名（兜底匹配用）
 */
function buildScript(targetPid, doFocus, launchExe, processName = TARGET_PROCESS_NAME) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$TargetPid = ${Number(targetPid) || 0}
$TargetName = '${esc(processName)}'
$DoFocus = $${doFocus ? 'true' : 'false'}
$LaunchExe = '${esc(launchExe)}'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeskPetFocus {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

# 收集所有「有标题」的顶层窗口 —— **包含不可见的**。
# 为什么要收不可见的：DSH 缩到托盘时是把主窗口 hide() 掉，HWND 仍然存在、标题也没丢，
# 只是 IsWindowVisible = false。只枚举可见窗口就会漏掉它，于是"托盘里叫不出来"。
$script:wins = New-Object System.Collections.ArrayList
[void][DeskPetFocus]::EnumWindows({
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][DeskPetFocus]::GetWindowText($h, $sb, 512)
  if ($sb.Length -gt 0) {
    $procId = 0
    [void][DeskPetFocus]::GetWindowThreadProcessId($h, [ref]$procId)
    $cls = New-Object System.Text.StringBuilder 256
    [void][DeskPetFocus]::GetClassName($h, $cls, 256)
    [void]$script:wins.Add([pscustomobject]@{
      hwnd    = $h
      pid     = [int]$procId
      title   = $sb.ToString()
      cls     = $cls.ToString()
      visible = [DeskPetFocus]::IsWindowVisible($h)
      iconic  = [DeskPetFocus]::IsIconic($h)
    })
  }
  return $true
}, [IntPtr]::Zero)

# Electron 主窗口的窗口类；托盘里被 hide 的也是它，用它把主窗口从一堆辅助窗口里挑出来
$MainClass = 'Chrome_WidgetWin_1'

# 选窗优先级：可见的优先，其次托盘里被隐藏的主窗口
#   1. 精确 pid + 可见
#   2. 精确 pid + 主窗口类（隐藏中，即托盘）
#   3. 按进程名兜底（pid 过期时）+ 可见
#   4. 按进程名兜底 + 主窗口类（隐藏中）
$target = $script:wins | Where-Object { $_.pid -eq $TargetPid -and $_.visible } | Select-Object -First 1
if (-not $target -and $TargetPid -gt 0) {
  $target = $script:wins | Where-Object { $_.pid -eq $TargetPid -and $_.cls -eq $MainClass } | Select-Object -First 1
}
if (-not $target -and $script:wins.Count -gt 0) {
  $pids = $script:wins | Select-Object -ExpandProperty pid -Unique
  $nameOf = @{}
  foreach ($p in (Get-Process -Id $pids -ErrorAction SilentlyContinue)) { $nameOf[[int]$p.Id] = $p.ProcessName }
  $target = $script:wins | Where-Object { $nameOf[[int]$_.pid] -eq $TargetName -and $_.visible } | Select-Object -First 1
  if (-not $target) {
    $target = $script:wins | Where-Object { $nameOf[[int]$_.pid] -eq $TargetName -and $_.cls -eq $MainClass } | Select-Object -First 1
  }
}

$action = 'none'
$restored = $false
$focused = $false
$title = ''

if ($target) {
  $hwnd = $target.hwnd
  $title = $target.title
  # 窗口是隐藏的（托盘）就得先 show 出来：SW_SHOW = 5。
  # 注意顺序：show → restore（若最小化）→ 抢前台；刚 show 出来的窗口立刻抢前台常常失败，
  # 所以中间让它喘 80ms。
  $wasHidden = -not $target.visible
  if ($DoFocus) {
    if ($wasHidden) { [void][DeskPetFocus]::ShowWindowAsync($hwnd, 5) }
    if ($target.iconic) {
      [void][DeskPetFocus]::ShowWindowAsync($hwnd, 9)
      $restored = $true
    }
    if ($wasHidden) { Start-Sleep -Milliseconds 80 }
    [void][DeskPetFocus]::BringWindowToTop($hwnd)
    $focused = [DeskPetFocus]::SetForegroundWindow($hwnd)

    if (-not $focused) {
      # 兜底一：AttachThreadInput。系统只允许"当前前台进程"改前台窗口；把本线程的输入
      # 队列临时挂到当前前台窗口的线程上，系统就认这个请求，SetForegroundWindow 不再被拒。
      $dummy = 0
      $fg = [DeskPetFocus]::GetForegroundWindow()
      $fgThread = [DeskPetFocus]::GetWindowThreadProcessId($fg, [ref]$dummy)
      $curThread = [DeskPetFocus]::GetCurrentThreadId()
      if ($fgThread -ne 0 -and $fgThread -ne $curThread) {
        [void][DeskPetFocus]::AttachThreadInput($curThread, $fgThread, $true)
        $focused = [DeskPetFocus]::SetForegroundWindow($hwnd)
        [void][DeskPetFocus]::AttachThreadInput($curThread, $fgThread, $false)
      }
    }
    if (-not $focused) {
      # 兜底二：SwitchToThisWindow（未公开但一直在用的老 API），对刚 show 出来的窗口更管用
      [DeskPetFocus]::SwitchToThisWindow($hwnd, $true)
      Start-Sleep -Milliseconds 60
      $focused = ([DeskPetFocus]::GetForegroundWindow() -eq $hwnd)
    }
    if ($wasHidden) { $action = 'shown' } else { $action = 'focused' }
  } else {
    if ($wasHidden) { $action = 'would-show' } else { $action = 'located' }
  }
} else {
  $running = @(Get-Process -Name $TargetName -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    # 进程还在，只是没有可见窗口（托盘/正在启动）：绝不能启动第二个
    $action = 'running-no-window'
  } elseif ($LaunchExe -eq '') {
    $action = 'no-exe'
  } elseif (-not (Test-Path -LiteralPath $LaunchExe)) {
    $action = 'bad-exe'
  } elseif (-not $DoFocus) {
    $action = 'would-launch'
  } else {
    # 工作目录要设成 exe 所在目录：Start-Process 默认用调用者的当前目录，
    # 而应用可能按 CWD 解析相对路径，从宠物目录启动会出怪问题。
    Start-Process -FilePath $LaunchExe -WorkingDirectory (Split-Path -Parent $LaunchExe) | Out-Null
    $action = 'launched'
  }
}

$result = [pscustomobject]@{
  action    = $action
  targetPid = $TargetPid
  hwnd      = if ($target) { $target.hwnd.ToInt64() } else { 0 }
  foundPid  = if ($target) { $target.pid } else { 0 }
  title     = $title
  restored  = $restored
  focused   = $focused
  wasHidden = if ($target) { $wasHidden } else { $false }
}
Write-Output ('${RESULT_MARK}' + ($result | ConvertTo-Json -Compress))
`;
}

/**
 * 定位并聚焦 DSH；必要时启动它。
 * @param {{pid?: number, dryRun?: boolean, launchExe?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{action: string, hwnd?: number, foundPid?: number, title?: string, focused?: boolean, restored?: boolean}>}
 *   action: focused | located | would-launch | launched | running-no-window | no-exe | bad-exe | timeout | spawn-error | parse-error | no-result
 */
function locateOrLaunch(options = {}) {
  const pid = Number(options.pid ?? process.env.DSH_DESKPET_DSH_PID ?? 0) || 0;
  const launchExe = String(options.launchExe ?? process.env.DSH_DESKPET_DSH_EXE ?? '');
  const processName = String(options.processName ?? process.env.DSH_DESKPET_DSH_PROCESS ?? TARGET_PROCESS_NAME);
  const dryRun = options.dryRun === true;
  const timeoutMs = options.timeoutMs ?? 8000;
  const script = buildScript(pid, !dryRun, launchExe, processName);

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );

    let buf = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.error('[deskpet] 唤起/启动 DSH 超时');
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish({ action: 'timeout' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const at = buf.indexOf(RESULT_MARK);
      if (at < 0) return;
      const line = buf.slice(at + RESULT_MARK.length).split('\n')[0].trim();
      try {
        finish(JSON.parse(line));
      } catch (err) {
        console.error('[deskpet] 解析唤起结果失败：', err.message, line);
        finish({ action: 'parse-error' });
      }
    });
    child.on('error', (err) => {
      console.error('[deskpet] 唤起 DSH 失败：', err.message);
      finish({ action: 'spawn-error' });
    });
    child.on('exit', () => finish({ action: 'no-result' }));
  });
}

module.exports = { locateOrLaunch, buildScript, TARGET_PROCESS_NAME, RESULT_MARK };
