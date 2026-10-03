/**
 * 桌面助手进程的管理：找 Electron、拉起、守护、双向通信
 * ============================================================================
 * 两个方向各有一条可靠通道（这是本项目最关键的平台结论，别改回去）：
 *   助手 → 宿主：stdout 一行一个 JSON（日志行不带 JSON 前缀，按能否 parse 区分）
 *   宿主 → 助手：助手起一个 127.0.0.1 随机端口 HTTP 服务器，经 stdout 的 ready
 *                事件把地址报上来，宿主 POST /cmd 下发命令。
 *   为什么不能用 stdin：Electron 主进程在 Windows 收不到 piped stdin（electron#4218），
 *   实测一启动就 EOF（对照实验：同样重定向下纯 Node 进程能正常读到）。
 *
 * 另一条必须遵守的规矩：spawn 时**删掉 ELECTRON_RUN_AS_NODE**。
 * 宿主自己是 Electron-as-Node 起的，该变量会继承给子进程，导致 Electron 以纯 Node
 * 模式启动、require('electron') 直接 MODULE_NOT_FOUND。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 与本机已验证可用的版本保持一致（dsh-pet 下载的那份就是它） */
const DEFAULT_ELECTRON_VERSION = '43.3.0';
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface HelperPaths {
  /** 包根目录 */
  packageRoot: string;
  /** 日志文件路径（助手与宿主都写它，排障唯一现场） */
  logFile: string;
}

export interface HelperConfigPayload {
  pets: Array<{
    id: string;
    name: string;
    species: string;
    speciesName: string;
    /** 素材绝对路径（宿主负责解析，助手不再猜相对路径） */
    file: string;
    size: number;
    heightRatio: number;
    position: { corner: string; marginX: number; marginY: number };
  }>;
  /** 可切换的形象清单（助手右键菜单用它；宿主侧是唯一事实来源） */
  species: Array<{ id: string; name: string; file: string; heightRatio: number; width: number; height: number }>;
  roamEnabled: boolean;
  roam: unknown;
  physics: unknown;
  workStatusEnabled: boolean;
  notifyEnabled: boolean;
  notifySystemToast: boolean;
  clickToFocusDsh: boolean;
  workStatusTexts: string[][];
}

export interface HelperEvent {
  type: string;
  [k: string]: unknown;
}

export interface HelperProcessOptions extends HelperPaths {
  /** 助手入口（runtime/electron-helper/main.js） */
  helperEntry: string;
  /** 本次要下发的配置 */
  config: HelperConfigPayload;
  /** DSH 主进程 pid（= 宿主进程的父进程），用于「点击宠物唤起 DSH」 */
  dshPid: number;
  /** DSH 桌面客户端的可执行文件路径（DSH 退出后点宠物用它把应用拉起来） */
  dshExe: string;
  /** 用户数据目录（宠物用它放 helper.json 做新旧进程交接） */
  userRoot: string;
  log: (msg: string) => void;
  /** 助手上报的事件（ready / species-changed …） */
  onEvent?: (event: HelperEvent) => void;
  /** 连续失败上限，超过就放弃（避免疯狂重启刷日志） */
  maxFailures?: number;
}

/** 找回 Electron：环境变量 → 本机落地目录（dsh-pet 也会下到这里）→ 官网镜像下载 */
export function electronLandingDir(): string {
  return join(homedir(), '.dsh', 'electron');
}

export function findElectron(log: (m: string) => void): string | null {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const explicit = process.env.DSH_DESKPET_ELECTRON_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  if (explicit) log(`DSH_DESKPET_ELECTRON_PATH 指向的文件不存在：${explicit}`);
  const landed = join(electronLandingDir(), exeName);
  if (existsSync(landed)) return landed;
  return null;
}

/**
 * 命令通道客户端 + 进程守护。
 */
export class HelperProcess {
  private readonly options: HelperProcessOptions;
  private child: ChildProcess | null = null;
  private callbackUrl: string | null = null;
  private stdoutBuf = '';
  private stopping = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** 助手上报的能力（物种列表等），供设置页展示 */
  private lastReady: HelperEvent | null = null;

  constructor(options: HelperProcessOptions) {
    this.options = options;
  }

  get ready(): boolean {
    return this.callbackUrl !== null;
  }

  get readyInfo(): HelperEvent | null {
    return this.lastReady;
  }

  /** 启动；Electron 缺失时返回 false（不抛错，插件其余部分照常工作） */
  start(): boolean {
    if (this.stopping) return false;
    const electron = findElectron(this.options.log);
    if (!electron) {
      this.options.log(
        '找不到 Electron 运行时，桌面宠物已停用。' +
          `把 Electron 解压到 ${electronLandingDir()}（或设 DSH_DESKPET_ELECTRON_PATH），或设置 DSH_DESKPET_ALLOW_DOWNLOAD=1 让本插件自动下载。`,
      );
      if (process.env.DSH_DESKPET_ALLOW_DOWNLOAD === '1') void this.downloadElectron();
      return false;
    }
    this.spawn(electron);
    return true;
  }

  /** 改配置后重启（等旧进程真的退出再起新的，否则会出现两只宠物） */
  restart(config: HelperConfigPayload): void {
    this.options.config = config;
    if (this.child) {
      this.options.log('配置已变，重启桌面助手…');
      this.stopping = true;
      const child = this.child;
      child.once('exit', () => {
        this.stopping = false;
        this.callbackUrl = null;
        this.failures = 0;
        this.start();
      });
      child.kill();
      return;
    }
    this.callbackUrl = null;
    this.failures = 0;
    this.start();
  }

  /**
   * 插件卸载时调用。
   * **刻意不杀宠物进程**：需求是「DSH 退出后点桌宠能把应用打开」，所以宠物要活到 DSH 之外。
   * 这里只发一条 hostGone 让它转入孤儿模式（待机/漫游照旧，点击动作变成"启动 DSH"）。
   * 下一次 DSH 启动时，新宠物会读 helper.json 把旧的请出去，不会出现两只。
   * 想立刻收掉它：右键宠物 → 退出桌宠。
   */
  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = null;
    this.stableTimer = null;
    const url = this.callbackUrl;
    this.child = null;
    this.callbackUrl = null;
    if (!url) return;
    void fetch(`${url}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'hostGone' }),
      signal: AbortSignal.timeout(1500),
    })
      .then(() => this.options.log('已通知宠物进入孤儿模式（DSH 退出后仍可点它启动应用）'))
      .catch(() => {
        /* 宠物可能已经先走了；它的 pid 轮询也会自己发现宿主没了 */
      });
  }

  /**
   * 下发一条命令。通道未就绪时返回 false（调用方自行决定是否忽略）。
   */
  async send(cmd: Record<string, unknown>): Promise<boolean> {
    const url = this.callbackUrl;
    if (!url) return false;
    try {
      const res = await fetch(`${url}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) this.options.log(`命令下发失败：HTTP ${res.status}（${JSON.stringify(cmd).slice(0, 120)}）`);
      return res.ok;
    } catch (err) {
      this.options.log(`命令下发异常：${(err as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------ 内部 --

  private spawn(electron: string): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_DESKPET_CONFIG_JSON: JSON.stringify(this.options.config),
      DSH_DESKPET_DSH_PID: String(this.options.dshPid || 0),
      // DSH 退出后点宠物要靠它把应用拉起来
      DSH_DESKPET_DSH_EXE: this.options.dshExe,
      // 宿主自己（不是 DSH 主进程）：它一消失就说明 DSH 退出了 → 宠物转孤儿模式
      DSH_DESKPET_HOST_PID: String(process.pid),
      DSH_DESKPET_USER_ROOT: this.options.userRoot,
      DSH_DESKPET_LOG: this.options.logFile,
    };
    // 关键：不删掉它，Electron 会以纯 Node 模式启动（require('electron') 直接失败）
    delete env.ELECTRON_RUN_AS_NODE;

    this.options.log(`拉起桌面助手：${electron} ${this.options.helperEntry}`);
    const child = spawn(electron, [this.options.helperEntry], {
      cwd: join(this.options.packageRoot, 'runtime', 'electron-helper'),
      env,
      // stdin 一律 ignore：Electron 主进程在 Windows 读不到 piped stdin（electron#4218）
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 关键：Node 文档明确写着 —— Windows 上只有 detached:true，子进程才能在父进程退出后继续活着。
      // 这正是本插件的核心需求（DSH 退出后宠物要留在桌面上，点它把应用拉起来）。
      // 实测不加它：宿主一被杀，宠物进程跟着消失，孤儿模式根本来不及生效。
      detached: true,
    });
    // 不把宿主的生命周期绑在宠物身上（管道仍然可用，只是不再阻止宿主退出）
    child.unref();
    this.child = child;
    this.stdoutBuf = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.options.log(`[helper:err] ${text}`);
    });

    child.on('error', (err) => this.options.log(`桌面助手进程错误：${err.message}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.callbackUrl = null;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (this.stopping) {
        this.options.log('桌面助手已退出（插件停止中）');
        return;
      }
      this.options.log(`桌面助手退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.scheduleRestart();
    });
  }

  /** stdout 按行切：能 parse 成带 type 的 JSON = 事件，其余 = 日志 */
  private consumeStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown = null;
      if (line.startsWith('{')) {
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as HelperEvent).type === 'string') {
        this.handleEvent(parsed as HelperEvent);
      } else {
        this.options.log(`[helper] ${line}`);
      }
    }
  }

  private handleEvent(event: HelperEvent): void {
    if (event.type === 'ready') {
      this.callbackUrl = typeof event.callback === 'string' ? event.callback : null;
      this.lastReady = event;
      this.failures = 0;
      this.options.log(`桌面助手就绪：命令通道 ${this.callbackUrl ?? '(无)'}，形象 ${JSON.stringify(event.species ?? [])}`);
      // 连续稳定 3 分钟后把失败计数清零，避免偶发崩溃累积到熔断
      this.stableTimer = setTimeout(() => {
        this.failures = 0;
      }, 3 * 60_000);
      if (typeof this.stableTimer.unref === 'function') this.stableTimer.unref();
    }
    this.options.onEvent?.(event);
  }

  private scheduleRestart(): void {
    const max = this.options.maxFailures ?? 8;
    this.failures += 1;
    if (this.failures > max) {
      this.options.log(`桌面助手连续失败 ${this.failures} 次，已停止重试（改配置或重启 DSH 后再试）`);
      return;
    }
    const delay = Math.min(30_000, 750 * 2 ** (this.failures - 1));
    this.options.log(`${delay}ms 后重启桌面助手（第 ${this.failures} 次）`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  /**
   * 自动下载 Electron（未在本机验证过的路径：本机已有运行时，走不到这里）。
   * 用 Node 自带 fetch 抓镜像 zip，再交给 PowerShell 的 Expand-Archive 解压，零第三方依赖。
   */
  private async downloadElectron(): Promise<void> {
    const version = process.env.DSH_DESKPET_ELECTRON_VERSION || DEFAULT_ELECTRON_VERSION;
    const mirror = process.env.DSH_DESKPET_ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const file = `electron-v${version}-${platformKey}-${arch}.zip`;
    const url = `${mirror}/${version}/${file}`;
    const target = electronLandingDir();
    this.options.log(`开始下载 Electron ${version}：${url}`);
    try {
      const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const zipPath = join(mkdtempSync(join(tmpdir(), 'deskpet-electron-')), file);
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(zipPath, buf);
      mkdirSync(target, { recursive: true });
      const ps = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`;
      const code: number = await new Promise((resolve) => {
        const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
        p.on('exit', (c) => resolve(c ?? 1));
        p.on('error', () => resolve(1));
      });
      rmSync(zipPath, { force: true });
      if (code !== 0) throw new Error(`解压失败（Expand-Archive 退出码 ${code}）`);
      this.options.log(`Electron 已就绪：${target}`);
      this.start();
    } catch (err) {
      this.options.log(`Electron 下载失败：${(err as Error).message}。可手动放置到 ${target}`);
    }
  }
}
