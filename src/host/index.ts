/**
 * dsh-deskpet 宿主半侧（DSH 插件入口）
 * ============================================================================
 * 职责：
 *   1. 配置与形象清单的加载 / 归一化 / 落盘
 *   2. 拉起并守护桌面助手进程（独立 Electron），提供双向通道
 *   3. 监听 DSH 会话事件 → 工作状态（连续态）与提醒（离散事件）→ 推给宠物
 *   4. 给设置页提供 HTTP 接口
 *
 * 本文件不碰任何渲染：宠物长什么样、怎么动全在 runtime/electron-helper 里。
 * 依赖只有 Node 内置模块 + ctx 注入的 webServer。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DshCtx, DshRequest, DshResponse } from './dsh.js';
import {
  discoverSpecies,
  loadConfig,
  normalizeConfig,
  reconcileSpecies,
  saveConfig,
  type DeskPetConfig,
  type SpeciesEntry,
} from './config.js';
import { HelperProcess, type HelperConfigPayload, type HelperEvent } from './helper-process.js';
import { noticeFromAgentError, noticeFromEvent, type PetNotice } from './notify.js';
import { WorkStatusTracker, levelIndex, type SessionEvent, type WorkLevel, type WorkSnapshot } from './work-status.js';

export const name = 'deskpet';
/** 只依赖 DSH 的 HTTP 服务；其余（llm/credentials/commands）本插件一律不用，零模型成本 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-deskpet';
const BODY_MAX = 1 << 20;

/** 包根目录：lib/index.js → 上两级 */
function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** 会话 id：DSH 给的 session 对象有两种形状，都兜住 */
function sessionIdOf(session: unknown): string {
  const s = session as { id?: unknown; header?: { id?: unknown } } | null;
  return String(s?.header?.id ?? s?.id ?? 'unknown');
}

/** 配置 → 助手要的载荷：把形象解析成绝对素材路径，助手不再猜路径 */
function helperConfig(config: DeskPetConfig, species: SpeciesEntry[]): HelperConfigPayload {
  const fallback = species[0];
  return {
    pets: config.pets.map((p) => {
      const sp = species.find((s) => s.id === p.species) ?? fallback;
      return {
        id: p.id,
        name: p.name,
        species: sp?.id ?? p.species,
        speciesName: sp?.name ?? p.species,
        file: sp?.file ?? '',
        size: p.size,
        heightRatio: sp?.heightRatio ?? 1.8,
        position: { ...p.position },
      };
    }),
    species: species.map((s) => ({ id: s.id, name: s.name, file: s.file, heightRatio: s.heightRatio, width: s.width, height: s.height })),
    roamEnabled: config.roamEnabled,
    roam: config.roam,
    physics: config.physics,
    workStatusEnabled: config.workStatusEnabled,
    notifyEnabled: config.notifyEnabled,
    notifySystemToast: config.notifySystemToast,
    clickToFocusDsh: config.clickToFocusDsh,
    workStatusTexts: config.workStatusTexts,
  };
}

export function apply(ctx: DshCtx): void {
  const root = pluginRoot();
  const assetsDir = join(root, 'assets');
  const userRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-deskpet');
  const logFile = join(userRoot, 'helper.log');
  const paths = { assetsDir, userRoot };

  // 用户数据根必须先建出来：助手的日志、换皮写回、以及用户自建 pet pack 都落在这里。
  // 忘了建它会导致 appendFileSync 静默失败（日志全丢，排障时最要命）。
  try {
    mkdirSync(userRoot, { recursive: true });
  } catch (err) {
    console.warn(`[deskpet] 无法创建用户数据目录 ${userRoot}：${(err as Error).message}`);
  }

  const log = (msg: string): void => {
    if (ctx.logger?.info) ctx.logger.info(`[deskpet] ${msg}`);
    else console.log(`[deskpet] ${msg}`);
  };
  const warn = (msg: string): void => {
    if (ctx.logger?.warn) ctx.logger.warn(`[deskpet] ${msg}`);
    else console.warn(`[deskpet] ${msg}`);
  };

  // ------------------------------------------------------------ 状态 ----
  let species = discoverSpecies(paths);
  const loaded = loadConfig(paths);
  let config = reconcileSpecies(loaded.config, species).config;
  for (const w of loaded.warnings) warn(w);
  if (!species.length) warn(`没有发现任何形象素材：${join(assetsDir, 'pet')}/<id>/idle.png`);
  log(`配置载入完成：${config.pets.length} 只宠物，${species.length} 个形象，用户层${loaded.hasUserConfig ? '存在' : '不存在'}`);

  /** DSH 窗口是否在前台（由客户端半侧上报；未知时按「在前台」处理，避免误弹系统通知） */
  let dshFocused = true;

  const tracker = new WorkStatusTracker({
    onChange: (snap) => void pushWorkStatus(snap),
  });

  // -------------------------------------------------------- 助手进程 ----
  const helper = new HelperProcess({
    packageRoot: root,
    helperEntry: join(root, 'runtime', 'electron-helper', 'main.js'),
    logFile,
    config: helperConfig(config, species),
    // 宿主进程的父进程就是 DSH 桌面客户端主进程（实测进程树），拿它精确定位主窗口
    dshPid: process.ppid,
    // DSH 退出后点宠物要靠它启动应用：宿主自己就是这个 exe 跑起来的，execPath 即安装位置
    dshExe: process.execPath,
    userRoot,
    log,
    onEvent: (event) => handleHelperEvent(event),
  });

  async function handleHelperEvent(event: HelperEvent): Promise<void> {
    if (event.type === 'species-changed') {
      // 宠物右键换了形象：写回用户配置，保证重启后还是这只
      const petId = String(event.pet ?? '');
      const next = String(event.species ?? '');
      const pet = config.pets.find((p) => p.id === petId);
      if (!pet || pet.species === next || !species.some((s) => s.id === next)) return;
      config = { ...config, pets: config.pets.map((p) => (p.id === petId ? { ...p, species: next } : p)) };
      try {
        saveConfig(userRoot, config);
        log(`形象已写回用户配置：${petId} → ${next}`);
      } catch (err) {
        warn(`写回形象失败：${(err as Error).message}`);
      }
      return;
    }

    if (event.type === 'request-reload') {
      // 宠物右键「重载配置」：重读磁盘上的配置并让助手按新配置重启。
      // 为什么必须由宿主来做：助手只看宿主 spawn 时注入的 DSH_DESKPET_CONFIG_JSON，
      // 它自己 app.relaunch() 会拿到同一份旧环境变量，等于什么都没重载。
      log('宠物请求重载配置：重新读取磁盘配置…');
      try {
        species = discoverSpecies(paths);
        const reloaded = loadConfig(paths);
        const reconciled = reconcileSpecies(reloaded.config, species);
        config = reconciled.config;
        for (const w of [...reloaded.warnings, ...reconciled.warnings]) warn(w);
        helper.restart(helperConfig(config, species));
      } catch (err) {
        warn(`重载配置失败：${(err as Error).message}`);
      }
    }
  }

  async function pushWorkStatus(snap: WorkSnapshot): Promise<void> {
    if (!config.workStatusEnabled) return;
    const level = snap.level;
    const index = level ? levelIndex(level) : -1;
    await helper.send({
      cmd: 'workStatus',
      level,
      index,
      text: level ? pickWorkText(level, index, snap.task) : null,
      task: snap.task,
    });
  }

  /**
   * 档位文案：干活类（思考/干活/整理）优先用 todo 清单里的具体任务，
   * 其余档位从配置的备选句里随机抽一句（每档多句，避免重复看同一句）。
   */
  function pickWorkText(level: WorkLevel, index: number, task: string | null): string | null {
    if (task && (level === 'thinking' || level === 'working' || level === 'result')) return task;
    const row = config.workStatusTexts[index];
    if (!row || !row.length) return null;
    return row[Math.floor(Math.random() * row.length)] ?? null;
  }

  async function pushNotice(notice: PetNotice): Promise<void> {
    if (!config.notifyEnabled) return;
    await helper.send({
      cmd: 'notice',
      kind: notice.kind,
      text: notice.text,
      detail: notice.detail ?? null,
      level: notice.level,
      // 只有「DSH 不在前台」才值得弹系统通知：你正看着 DSH 时，宠物冒个气泡就够了
      toast: notice.toast && config.notifySystemToast && !dshFocused,
      dshFocused,
    });
  }

  ctx.effect(
    () => {
      helper.start();
      return () => helper.stop();
    },
    'dsh-deskpet: 桌面助手进程',
  );

  // -------------------------------------------------------- 会话事件 ----
  ctx.effect(
    () => {
      const offSession = ctx.on('session/event', (...args: unknown[]) => {
        const session = args[0];
        const event = args[1] as SessionEvent | undefined;
        if (!event?.type) return;
        const id = sessionIdOf(session);
        // 工作状态：连续态聚合
        tracker.apply(id, event);
        // 提醒：离散事件一对一映射
        const notice = noticeFromEvent(event);
        if (notice) void pushNotice(notice);
      });
      const offError = ctx.on('agent/error', (...args: unknown[]) => {
        void pushNotice(noticeFromAgentError(args[0]));
      });
      return () => {
        offSession();
        offError();
        tracker.dispose();
      };
    },
    'dsh-deskpet: 会话事件 → 宠物',
  );

  // ------------------------------------------------------------ 路由 ----
  const readBody = (req: DshRequest): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > BODY_MAX) reject(new Error('请求体过大'));
      });
      req.on('end', () => {
        if (!body) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err as Error);
        }
      });
      req.on('error', reject);
    });

  const sendJson = (res: DshResponse, status: number, obj: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  function metaInfo(): Record<string, unknown> {
    return {
      packageRoot: root,
      assetsDir,
      userRoot,
      userConfig: join(userRoot, 'main-config.jsonc'),
      helperLog: logFile,
      hasUserConfig: loaded.hasUserConfig,
      electron: existsSync(join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')),
    };
  }

  async function handle(req: DshRequest, res: DshResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && (path === '/config' || path === '/')) {
      // 每次读配置都重新扫形象：用户往 pet/ 里丢个文件夹刷新页面就能看到
      species = discoverSpecies(paths);
      sendJson(res, 200, { config, species, meta: metaInfo() });
      return;
    }

    if (method === 'GET' && path === '/state') {
      sendJson(res, 200, {
        helperReady: helper.ready,
        helper: helper.readyInfo,
        workStatus: tracker.current(),
        dshFocused,
        species: species.map((s) => s.id),
      });
      return;
    }

    if (method === 'PUT' && path === '/config') {
      const body = (await readBody(req)) as { config?: unknown } | null;
      if (!body || typeof body !== 'object' || body.config === undefined) {
        sendJson(res, 400, { error: '缺少 config 字段' });
        return;
      }
      const normalized = normalizeConfig(body.config);
      const reconciled = reconcileSpecies(normalized.config, species);
      config = reconciled.config;
      const warnings = [...normalized.warnings, ...reconciled.warnings];
      saveConfig(userRoot, config);
      log(`配置已保存（${config.pets.length} 只宠物）${warnings.length ? `，${warnings.length} 条告警` : ''}`);
      helper.restart(helperConfig(config, species));
      sendJson(res, 200, { config, warnings });
      return;
    }

    // 设置页 / 调试用：让宠物立刻演一次提醒或某个工作档位
    if (method === 'POST' && path === '/dev/notice') {
      const body = (await readBody(req)) as { kind?: string } | null;
      const kind = body?.kind ?? 'done';
      const table: Record<string, PetNotice> = {
        done: { kind: 'done', text: '这一轮搞定啦！', level: 'success', toast: true },
        error: { kind: 'error', text: '刚才这一步出错了…', detail: '（测试提醒）', level: 'error', toast: true },
        approval: { kind: 'approval', text: '需要你确认一下～', detail: '（测试提醒）', level: 'attention', toast: true },
        question: { kind: 'question', text: '有个问题等你回答', level: 'attention', toast: true },
        truncated: { kind: 'truncated', text: '输出太长被截断了', level: 'attention', toast: true },
      };
      const notice = table[kind] ?? table.done;
      // 测试按钮要能立刻看到效果：即使 DSH 在前台也带上 toast，并且回显**真正发出去的载荷**
      const payload = { cmd: 'notice', ...notice, toast: config.notifySystemToast, dshFocused };
      const ok = await helper.send(payload);
      sendJson(res, 200, { ok, sent: payload, helperReady: helper.ready });
      return;
    }

    if (method === 'POST' && path === '/dev/work') {
      const body = (await readBody(req)) as { level?: string } | null;
      const level = (body?.level ?? 'working') as WorkLevel;
      const index = levelIndex(level);
      await helper.send({ cmd: 'workStatus', level, index, text: pickWorkText(level, index, null) });
      sendJson(res, 200, { ok: true, level });
      return;
    }

    if (method === 'POST' && path === '/focus') {
      const body = (await readBody(req)) as { focused?: unknown } | null;
      dshFocused = body?.focused !== false;
      sendJson(res, 200, { ok: true, dshFocused });
      return;
    }

    sendJson(res, 404, { error: `未知端点：${method} ${path}` });
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handle(req, res).catch((err: unknown) => {
            warn(`路由处理失败：${(err as Error).message}`);
            try {
              sendJson(res, 500, { error: (err as Error).message });
            } catch {
              /* 响应可能已经发出去了 */
            }
          });
        },
      }),
    'dsh-deskpet: 设置页 HTTP 接口',
  );

  log(`插件已装载，接口前缀 ${ROUTE_PREFIX}`);
}
