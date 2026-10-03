'use strict';
/**
 * dsh-deskpet 桌面运行时主进程
 * ============================================================================
 * 职责（尽量薄）：
 *   1. 每只宠物开一个 **局部透明置顶小窗**（尺寸 = 精灵 + 四周留白，永不铺满屏幕）
 *   2. 默认整窗点击穿透，只在**宠物身体命中区**内翻成可交互（主进程侧光标轮询兜底）
 *   3. 按 renderer 上报的坐标移动窗口（拖动 / 抛掷 / 漫游都由 renderer 算，主进程只搬窗）
 *   4. 右键菜单、唤起 DSH、退出
 *
 * 坐标口径：全部 DIP（= CSS px）。窗口按 DIP 摆放，多屏缩放交给系统。
 *
 * 为什么不铺满全屏：透明置顶窗若「铺满屏幕 + 非点击穿透 + 可聚焦且已聚焦」会命中
 * Windows DWM 的视频合成缺陷导致黑屏（dsh-pet 的文件头注释记录了这个坑），
 * 所以本插件同样坚持「窗口只包住宠物」。
 */
const { app, BrowserWindow, screen, ipcMain, Menu, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig, normalizeSpecies, resolveSpecies, scanSpeciesDir, geometryFor, initialPos, clampWindowPos } = require('./config');
const { locateOrLaunch } = require('./focus-dsh');
const { startCommandServer } = require('./command-server');

/**
 * 诊断日志。
 * Windows 上 Electron 是 GUI 子系统程序，宿主用管道 spawn 时 console 输出并不可靠，
 * 所以 DSH_DESKPET_LOG 指向文件时同时落盘——桌面宠物出问题时这是唯一的现场证据。
 */
const LOG_FILE = process.env.DSH_DESKPET_LOG || '';
if (LOG_FILE) {
  // 目录不存在就自己建：appendFileSync 在目录缺失时会抛错，而日志是出问题时唯一的现场
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    /* 建不出来就只走 stdout */
  }
}
/** 宿主管道是否已经断了（断一次就够） */
let stdoutBroken = false;

function log(...args) {
  const line = `[deskpet ${new Date().toISOString()}] ${args.join(' ')}`;
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
      /* 日志失败不能影响宠物 */
    }
  }
  if (!stdoutBroken) console.log(line);
}

/**
 * 宿主一退出，stdout 这根管道的**读端**就关了，宠物下一次写会拿到 EPIPE。
 * Node 会把它当成未处理的 'error' 事件**直接把进程崩掉**——而"宿主退出"恰恰是
 * 我们必须活下来的场景（宠物要留着，点它才能把 DSH 拉起来）。
 * 所以：吞掉 EPIPE，并把它当作"宿主没了"的信号（比每 2 秒轮询更及时）。
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    const code = err && err.code;
    if (code === 'EPIPE') {
      if (!stdoutBroken) {
        stdoutBroken = true;
        try {
          enterOrphanMode();
        } catch {
          /* 此时还在启动早期的话就算了，pid 轮询会兜住 */
        }
      }
      return;
    }
    // 其它写错误同样不该把宠物带走
  });
}

process.on('uncaughtException', (err) => log('uncaughtException:', err && err.stack ? err.stack : String(err)));
process.on('unhandledRejection', (err) => log('unhandledRejection:', err && err.stack ? err.stack : String(err)));

app.disableHardwareAcceleration(); // 透明窗走软件合成，规避 WS_EX_LAYERED + DWM 缺陷
app.setName('dsh-deskpet-helper');
// Windows 的系统通知要靠 AppUserModelID 归位，不设的话 toast 可能不显示
if (process.platform === 'win32') app.setAppUserModelId('dsh-deskpet');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

log(`module loaded pid=${process.pid} ppid=${process.ppid} electron=${process.versions.electron} argv=${process.argv.slice(1).join(' ')}`);

/** DSH 主进程 pid（宿主启动本进程时注入；= 宿主进程的父进程） */
const DSH_PID = Number(process.env.DSH_DESKPET_DSH_PID || 0);
/** DSH 可执行文件路径（宿主注入），DSH 退出后点宠物用它把应用拉起来 */
const DSH_EXE = String(process.env.DSH_DESKPET_DSH_EXE || '');
/** 宿主进程 pid：它一消失就说明 DSH 退出了，宠物转入"孤儿模式"继续留在桌面上 */
const HOST_PID = Number(process.env.DSH_DESKPET_HOST_PID || 0);
/** 用户数据目录（放 helper.json，用于新旧宠物进程交接） */
const USER_ROOT = String(process.env.DSH_DESKPET_USER_ROOT || path.dirname(LOG_FILE || ''));

const CFG = loadConfig(process.env, (p) => fs.readFileSync(p, 'utf8'));

/** 素材根目录（开发态直接读包内；打包后由宿主经 HTTP 供应，见 README 架构说明） */
const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'pet');

/**
 * 可切换的形象清单。
 * 正式路径：宿主扫好经配置传进来（唯一事实来源）。
 * 本地开发：不经过 DSH 直接跑助手时，按 <assets>/pet/<id>/idle.png 自己扫。
 */
const SPECIES = (() => {
  if (CFG.species && CFG.species.length) return CFG.species;
  const list = scanSpeciesDir(ASSET_DIR);
  log(list.length ? `本地扫描到 ${list.length} 个形象：${list.map((s) => s.id).join(', ')}` : `本地没有形象素材（${ASSET_DIR}/<id>/idle.png）`);
  return list;
})();

/** 某只宠物该用哪个形象：优先匹配清单，其次用它自带的素材路径 */
function speciesForPet(pet) {
  const found = SPECIES.find((s) => s.id === pet.species);
  if (found) return found;
  if (pet.file) {
    return { id: pet.species, name: pet.species, file: pet.file, width: 0, height: 0, heightRatio: pet.heightRatio };
  }
  return resolveSpecies(pet, SPECIES);
}

/** 向宿主上报事件（stdout 一行一个 JSON） */
function emit(obj) {
  if (stdoutBroken) return;
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    /* 宿主不在时忽略 */
  }
}

/** @type {Map<string, any>} 宠物 id -> 运行状态 */
const states = new Map();
/** @type {Map<number, any>} webContents.id -> 运行状态 */
const bySender = new Map();
let hoverPoll = null;

// ============================================================================
// 生命周期：让宠物活到 DSH 之外
// ----------------------------------------------------------------------------
// 需求是「DSH 退出后，点桌宠能把应用打开」，所以宠物进程**不能跟着 DSH 一起死**：
//   · 宿主进程一消失（每 2 秒探一次）→ 进入"孤儿模式"：宠物继续待机/漫游，
//     点击动作从"聚焦 DSH"变成"启动 DSH"；
//   · 下一次 DSH 启动时，新宠物会先读 helper.json 把旧的那只请出去 —— 不会出现两只。
// ============================================================================

/** 是否处于孤儿模式（DSH 已退出、宠物仍在桌面上） */
let orphan = false;
/** 宿主存活轮询定时器 */
let hostPoll = null;

/** 把一条推送发给所有宠物窗口 */
function pushAll(msg) {
  for (const st of states.values()) {
    if (!st.win.isDestroyed()) st.win.webContents.send('deskpet:push', msg);
  }
}

function helperStateFile() {
  return path.join(USER_ROOT, 'helper.json');
}

/** 记下自己（pid + 命令通道），供下一次启动交接 */
function writeHelperState() {
  if (!USER_ROOT) return;
  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    fs.writeFileSync(
      helperStateFile(),
      JSON.stringify(
        { pid: process.pid, callback: commandChannel ? commandChannel.url : null, dshPid: DSH_PID, startedAt: Date.now() },
        null,
        2,
      ),
      'utf8',
    );
  } catch (err) {
    log(`写 helper.json 失败：${err && err.message}`);
  }
}

function removeHelperState() {
  if (!USER_ROOT) return;
  try {
    const info = JSON.parse(fs.readFileSync(helperStateFile(), 'utf8'));
    if (Number(info.pid) === process.pid) fs.rmSync(helperStateFile(), { force: true });
  } catch {
    /* 文件不在/坏了都无所谓 */
  }
}

/** 进程是否还活着（EPERM 说明存在但没权限，也算活着） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** 启动时把上一只（DSH 退出后留下的）宠物请出去，避免桌面上出现两只 */
async function evictPreviousHelper() {
  if (!USER_ROOT) return;
  const file = helperStateFile();
  if (!fs.existsSync(file)) return;
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 坏的当没有 */
  }
  const pid = Number(info && info.pid);
  if (!info || pid === process.pid || !pidAlive(pid)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
    return;
  }
  log(`发现上一只宠物还在（pid=${pid}），请它退出…`);
  try {
    if (typeof info.callback === 'string' && info.callback) {
      await fetch(`${info.callback}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'quit' }),
        signal: AbortSignal.timeout(2000),
      });
    }
  } catch {
    /* 端口可能已经没了，继续按 pid 等 */
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 150));
  log(pidAlive(pid) ? `上一只宠物（pid=${pid}）没退出，可能会出现两只` : '上一只宠物已退出');
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 宿主没了 = DSH 退出了：转孤儿模式，点击改为启动 DSH */
function enterOrphanMode() {
  if (orphan) return;
  orphan = true;
  if (hostPoll) {
    clearInterval(hostPoll);
    hostPoll = null;
  }
  log('宿主已退出（DSH 关掉了）：宠物进入孤儿模式，点击将启动 DeepSeek Harness');
  pushAll({ type: 'bubble', text: 'DSH 关掉啦，点我就能打开～', level: 'info', ms: 10000 });
}

function startHostWatch() {
  if (!Number.isInteger(HOST_PID) || HOST_PID <= 0) return;
  hostPoll = setInterval(() => {
    if (!pidAlive(HOST_PID)) enterOrphanMode();
  }, 2000);
  if (typeof hostPoll.unref === 'function') hostPoll.unref();
}

/** 点击宠物：聚焦 DSH；缩在托盘里就 show 出来；已经退出就启动它 */
async function bringDshBack() {
  const r = await locateOrLaunch({ pid: DSH_PID, launchExe: DSH_EXE });
  log(`点击宠物 → ${r.action}${r.title ? `（${r.title}）` : ''}${r.hwnd ? ` hwnd=${r.hwnd}` : ''}`);
  if (r.action === 'shown') pushAll({ type: 'bubble', text: '从托盘里叫回来啦～', level: 'success', ms: 4000 });
  else if (r.action === 'launched') pushAll({ type: 'bubble', text: '正在打开 DeepSeek Harness…', level: 'info', ms: 6000 });
  else if (r.action === 'running-no-window') pushAll({ type: 'bubble', text: 'DSH 在运行但找不到窗口，点任务栏图标看看～', level: 'attention', ms: 7000 });
  else if (r.action === 'no-exe' || r.action === 'bad-exe') pushAll({ type: 'bubble', text: '找不到 DeepSeek Harness 的安装位置…', level: 'error', ms: 8000 });
  else if (r.action !== 'focused' && r.action !== 'located') pushAll({ type: 'bubble', text: `叫 DSH 没成功（${r.action}）`, level: 'error', ms: 8000 });
  return r;
}

/** 主显示器工作区（DIP）。多屏选择器等后续再加。 */
function workArea() {
  const d = screen.getPrimaryDisplay();
  return { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height };
}

/** 夹回工作区（供 renderer 请求移动时兜底） */
function clampFor(st, x, y) {
  return clampWindowPos(st.area, st.geom, x, y);
}

function createPetWindow(pet) {
  const species = speciesForPet(pet);
  const geom = geometryFor({ size: pet.size, heightRatio: species.heightRatio });
  const area = workArea();
  const pos = initialPos(area, pet, geom);

  const win = new BrowserWindow({
    width: geom.w,
    height: geom.h,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 被遮挡也要继续渲染，否则宠物会「停止呼吸」
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // 默认整窗穿透
  win.setMenuBarVisibility(false);
  win.setBackgroundColor('#00000000');

  const st = {
    id: pet.id,
    pet,
    species,
    geom,
    area,
    win,
    pos,
    /** 命中区（窗口内坐标，固定不变：窗口永远跟着精灵走） */
    hit: geom.hit,
    interactive: false,
    locked: false, // 拖拽/菜单期间锁住，绝不翻回穿透（否则丢 pointerup）
  };
  states.set(pet.id, st);
  // 先把 webContents.id 抓下来：窗口 closed 之后 win.webContents 已经销毁，
  // 那时再访问 .id 会抛 "Object has been destroyed"（实测在退出时刷了一串异常栈）
  const wcId = win.webContents.id;
  bySender.set(wcId, st);

  win.on('closed', () => {
    states.delete(pet.id);
    bySender.delete(wcId);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.showInactive()); // 不抢焦点

  return st;
}

function initPayload(st) {
  return {
    pet: st.pet,
    species: st.species,
    speciesList: SPECIES,
    geom: st.geom,
    area: st.area,
    pos: st.pos,
    config: {
      roamEnabled: CFG.roamEnabled,
      roam: CFG.roam,
      physics: CFG.physics,
      clickToFocusDsh: CFG.clickToFocusDsh,
      workStatusEnabled: CFG.workStatusEnabled,
      notifyEnabled: CFG.notifyEnabled,
      workStatusTexts: CFG.workStatusTexts,
    },
  };
}

function moveTo(st, x, y) {
  const p = clampWindowPos(st.area, st.geom, x, y);
  st.pos = p;
  if (st.win.isDestroyed()) return p;
  const b = st.win.getBounds();
  if (b.x !== p.x || b.y !== p.y) st.win.setBounds({ x: p.x, y: p.y, width: st.geom.w, height: st.geom.h });
  return p;
}

/**
 * 点击穿透的兜底通道：每 50ms 用真实光标位置判一次命中。
 * 不用 renderer 的 mousemove 是因为「已穿透的窗口」能否稳定收到 move 事件在
 * Windows 上并不可靠（dsh-pet 同样保留了这条独立判定通道）。
 */
function startHoverPoll() {
  if (hoverPoll) clearInterval(hoverPoll);
  hoverPoll = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const st of states.values()) {
      if (st.locked) continue;
      // isDestroyed 检查与后续调用之间仍有竞态（退出瞬间窗口会被销毁），
      // 这里整体兜住：轮询抛出去的异常会变成 uncaughtException，刷一屏噪音还盖住真错误。
      try {
        if (st.win.isDestroyed()) continue;
        const b = st.win.getBounds();
        const h = st.hit;
        const inside =
          p.x >= b.x + h.x && p.x < b.x + h.x + h.w && p.y >= b.y + h.y && p.y < b.y + h.y + h.h;
        if (inside !== st.interactive) {
          st.interactive = inside;
          st.win.setIgnoreMouseEvents(!inside, { forward: true });
          st.win.webContents.send('deskpet:hover', inside);
        }
      } catch {
        /* 窗口正在销毁：跳过这一轮 */
      }
    }
  }, 50);
}

/**
 * 切换形象（换皮）。
 * 关键：保持「精灵底边中心」不动——否则两张素材高宽比不同，换皮瞬间宠物会跳走。
 */
function switchSpecies(st, id) {
  const sp = SPECIES.find((s) => s.id === id);
  if (!sp) {
    log(`切换形象失败：物种清单里没有 "${id}"（现有：${SPECIES.map((s) => s.id).join(', ') || '无'}）`);
    return;
  }
  if (st.species && st.species.id === id) return;

  const oldGeom = st.geom;
  const newGeom = geometryFor({ size: st.pet.size, heightRatio: sp.heightRatio });
  const centerX = st.pos.x + oldGeom.w / 2;
  const spriteBottomY = st.pos.y + oldGeom.padTop + oldGeom.spriteH;
  const newPos = clampWindowPos(st.area, newGeom, centerX - newGeom.w / 2, spriteBottomY - (newGeom.padTop + newGeom.spriteH));

  st.species = sp;
  st.geom = newGeom;
  st.hit = newGeom.hit;
  st.pos = newPos;
  st.sentX = null; // 让 renderer 重新同步一次窗口位置

  if (!st.win.isDestroyed()) {
    st.win.setBounds({ x: newPos.x, y: newPos.y, width: newGeom.w, height: newGeom.h });
    st.win.webContents.send('deskpet:species', { species: sp, geom: newGeom, area: st.area, pos: newPos });
  }
  log(`切换形象 ${st.id}: ${sp.id} (${sp.name}) ${newGeom.w}x${newGeom.h}`);
  emit({ type: 'species-changed', pet: st.id, species: sp.id });
}

/**
 * 宿主 → 宠物 的命令通道。
 * 走**本机 HTTP 回调服务器**而不是 stdin：Electron 主进程在 Windows 上收不到
 * piped stdin（electron#4218），实测 stdin 一启动就 EOF。详见 command-server.js。
 *
 * 就绪前收到的命令先排队：宿主完全可能在 spawn 之后立刻发命令，
 * 那时窗口还没建好——排队后统一在 ready 时执行，避免命令被静默吞掉。
 */
let appReady = false;
let commandChannel = null;
const pendingCommands = [];

function dispatchCommand(msg) {
  const st = msg.pet ? states.get(msg.pet) : [...states.values()][0];
  switch (msg.cmd) {
    case 'setSpecies':
      if (st) switchSpecies(st, String(msg.species));
      break;
    case 'bubble':
      if (st && !st.win.isDestroyed()) {
        st.win.webContents.send('deskpet:push', { type: 'bubble', text: msg.text, level: msg.level, ms: msg.ms });
      }
      break;
    case 'workStatus':
      // 连续态：level 为 null 表示回到空闲
      if (st && !st.win.isDestroyed()) {
        st.win.webContents.send('deskpet:push', {
          type: 'workStatus',
          level: msg.level ?? null,
          index: msg.index,
          text: msg.text ?? null,
        });
      }
      break;
    case 'notice':
      // 离散提醒：宠物演一下 + 冒气泡；DSH 不在前台时再补一个系统通知
      if (st && !st.win.isDestroyed()) {
        st.win.webContents.send('deskpet:push', {
          type: 'notice',
          kind: msg.kind,
          text: msg.text,
          detail: msg.detail ?? null,
          level: msg.level,
        });
      }
      if (msg.toast) showToast(msg, st);
      break;
    case 'home':
      if (st) {
        const h = initialPos(st.area, st.pet, st.geom);
        moveTo(st, h.x, h.y);
        st.win.webContents.send('deskpet:home', h);
      }
      break;
    case 'focus-dsh':
      void bringDshBack();
      break;
    case 'hostGone':
      // 宿主优雅退出时主动告知（比 pid 轮询更快）
      enterOrphanMode();
      break;
    case 'quit':
      app.quit();
      break;
    default:
      log(`未知命令：${String(msg.cmd)}`);
  }
}

function handleCommand(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (!appReady) {
    pendingCommands.push(msg);
    return;
  }
  dispatchCommand(msg);
}

/** 系统通知标题（按提醒类型） */
function toastTitle(kind) {
  switch (kind) {
    case 'done':
      return 'DeepSeek Harness · 干完了';
    case 'error':
      return 'DeepSeek Harness · 出错了';
    case 'truncated':
      return 'DeepSeek Harness · 输出被截断';
    case 'approval':
      return 'DeepSeek Harness · 等你确认';
    case 'question':
      return 'DeepSeek Harness · 等你回答';
    default:
      return 'DeepSeek Harness';
  }
}

/**
 * 弹 Windows 系统通知。点通知直接把 DSH 叫回前台。
 * 失败只记日志：气泡已经在宠物头上显示了，通知只是加分项，
 * 而且 Windows 的 toast 依赖 AppUserModelID 注册，未打包的 Electron 上有失败的可能。
 */
function showToast(msg, st) {
  try {
    if (!Notification.isSupported()) {
      log('系统通知不受支持，已跳过（宠物气泡照常显示）');
      return;
    }
    const body = [msg.text, msg.detail].filter((s) => typeof s === 'string' && s).join(' — ');
    const notice = new Notification({ title: toastTitle(msg.kind), body: body || '点我看一眼', silent: false });
    notice.on('click', () => {
      void bringDshBack();
      if (st && !st.win.isDestroyed()) st.win.showInactive();
    });
    notice.show();
    log(`系统通知已弹出：${msg.text}`);
  } catch (err) {
    log(`系统通知失败：${err && err.message}`);
  }
}

function popupMenu(st, at) {
  const home = initialPos(st.area, st.pet, st.geom);
  const template = [
    {
      // 孤儿模式下这句话就是"把 DSH 打开"，措辞跟着状态走
      label: orphan ? '打开 DeepSeek Harness' : '唤起 DeepSeek Harness',
      click: () => void bringDshBack(),
    },
    {
      label: '切换形象',
      submenu: SPECIES.length
        ? SPECIES.map((s) => ({
            label: s.name,
            type: 'radio',
            checked: st.species && st.species.id === s.id,
            click: () => switchSpecies(st, s.id),
          }))
        : [{ label: '（未找到 species.json）', enabled: false }],
    },
    {
      label: '回到初始位置',
      click: () => {
        moveTo(st, home.x, home.y);
        st.win.webContents.send('deskpet:home', home);
      },
    },
    { type: 'separator' },
    {
      label: '重载配置',
      click: () => {
        if (!stdoutBroken && HOST_PID) {
          // 正式运行：配置由宿主持有（spawn 时经环境变量注入），必须让宿主重读磁盘后
          // 再按新配置重启本进程。自己 app.relaunch() 只会拿到同一份旧环境变量，等于没重载。
          log('请求宿主重载配置…');
          emit({ type: 'request-reload' });
          pushAll({ type: 'bubble', text: '正在重载配置…', level: 'info', ms: 4000 });
          return;
        }
        // 本地单跑（没有宿主）：直接重启自己，配置会从文件重新读
        app.relaunch();
        app.exit(0);
      },
    },
    { label: '退出桌宠', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({
    window: st.win,
    x: Math.round(Number(at && at.x) || 0),
    y: Math.round(Number(at && at.y) || 0),
  });
}

function registerIpc() {
  ipcMain.handle('deskpet:ready', (e) => {
    const st = bySender.get(e.sender.id);
    return st ? initPayload(st) : null;
  });

  ipcMain.on('deskpet:move', (e, x, y) => {
    const st = bySender.get(e.sender.id);
    if (!st || !Number.isFinite(x) || !Number.isFinite(y)) return;
    moveTo(st, x, y);
  });

  ipcMain.on('deskpet:lock', (e, locked) => {
    const st = bySender.get(e.sender.id);
    if (!st) return;
    st.locked = locked === true;
    if (st.locked) {
      st.interactive = true;
      st.win.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on('deskpet:focus-dsh', (e) => {
    const st = bySender.get(e.sender.id);
    // 先把本进程顶成前台，再抢前台给 DSH：Windows 只允许「当前前台进程」改前台窗口。
    // 用户点宠物时本窗口本来就会被激活，这里是廉价保险（透明置顶窗偶尔不激活）。
    try {
      if (st && !st.win.isDestroyed()) st.win.focus();
    } catch {
      /* 忽略 */
    }
    void bringDshBack();
  });

  ipcMain.on('deskpet:menu', (e, at) => {
    const st = bySender.get(e.sender.id);
    if (st) popupMenu(st, at);
  });

  ipcMain.on('deskpet:quit', () => app.quit());
}

// 刻意**不用** requestSingleInstanceLock：DSH 退出后宠物会作为"孤儿"继续活着并持有锁，
// 那样下一次 DSH 启动时**新宠物**反而会被锁挡掉、直接退出，桌面上就永远只剩旧的那只。
// 交接改由 helper.json 完成：新进程启动时把旧的请出去（见 evictPreviousHelper）。
app.whenReady().then(async () => {
  log(`app ready，物种清单 ${SPECIES.length} 项：${SPECIES.map((s) => `${s.id}(${s.name})`).join(', ') || '空'}`);
  try {
    registerIpc();
    commandChannel = await startCommandServer(handleCommand, log);
    // 先请走上一只，再建自己的窗：否则桌面上会同时出现两只
    await evictPreviousHelper();
    writeHelperState();
    for (const pet of CFG.pets) {
      const st = createPetWindow(pet);
      log(`建窗完成 id=${pet.id} species=${st.species.id} bounds=${JSON.stringify(st.win.getBounds())} geom=${st.geom.w}x${st.geom.h}`);
    }
    startHoverPoll();
    startHostWatch();
  } catch (err) {
    log('建窗失败：', err && err.stack ? err.stack : String(err));
  }

  // 常驻托盘/无窗时不退出：宠物窗被关掉才退出
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (hoverPoll) clearInterval(hoverPoll);
    if (hostPoll) clearInterval(hostPoll);
    removeHelperState();
    if (commandChannel) commandChannel.close();
  });

  // 先放行命令通道，再上报 ready：宿主收到 ready 后立刻发命令不会被排队
  appReady = true;
  emit({
    type: 'ready',
    pets: CFG.pets.map((p) => p.id),
    species: SPECIES.map((s) => s.id),
    callback: commandChannel ? commandChannel.url : null,
  });
  log(
    `helper ready: ${CFG.pets.length} 只宠物, DSH pid=${DSH_PID || '未提供'}, ` +
      `启动器=${DSH_EXE || '未提供（DSH 退出后无法自动启动）'}, 宿主监控=${HOST_PID || '关闭'}`,
  );

  // 放行排队中的命令（宿主可能在窗口建好前就发过来了）
  if (pendingCommands.length) {
    log(`执行排队命令 ${pendingCommands.length} 条`);
    for (const msg of pendingCommands.splice(0)) dispatchCommand(msg);
  }
});
