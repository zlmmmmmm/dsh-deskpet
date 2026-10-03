/**
 * 工作状态聚合（宿主侧纯逻辑）
 * ============================================================================
 * 把 DSH 的 `session/event` 流压缩成「此刻宠物该摆什么姿势」，共 6 档，
 * 档位索引与配置里的 `workStatusTexts` 一一对应：
 *   0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error
 *
 * 为什么需要「按会话聚合 + 优先级」而不是简单映射：
 *   - 可能有多个会话同时活跃（主会话 + 子代理），必须只展示一个最该展示的状态；
 *   - 终态（完成/出错）只是瞬时事件，展示一小段时间后要自动退场，
 *     否则一轮结束之后宠物会永远保持"庆祝"姿势。
 *
 * 纯监听，不调用任何模型，零 token 成本。
 */

export type WorkLevel = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

export const WORK_LEVELS: readonly WorkLevel[] = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];

/** 档位索引（= workStatusTexts 的下标） */
export function levelIndex(level: WorkLevel): number {
  const i = WORK_LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

/**
 * 展示优先级：等用户确认 > 出错 > 干活 > 思考 > 单步完成 > 全部完成。
 * result 高于 success，是为了避免"某个会话刚完成"压掉"另一个会话正在进行的过渡态"。
 */
const PRIORITY: Record<WorkLevel, number> = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** 终态展示时长：过后自动清条目，回到空闲 */
export const TERMINAL_TTL_MS = 60_000;

/** 任务详情文案上限（码点），避免把气泡撑成好几行盖住宠物 */
export const TASK_TEXT_MAX = 40;

export interface SessionEvent {
  type?: string;
  seq?: number;
  data?: {
    name?: unknown;
    arguments?: unknown;
    reason?: { kind?: unknown; error?: { message?: unknown } };
    todos?: Array<{ status?: unknown; content?: unknown }>;
    source?: { kind?: unknown };
    toolName?: unknown;
    [k: string]: unknown;
  };
}

interface SessionEntry {
  level: WorkLevel;
  seq: number;
  task: string | null;
}

interface TurnFlags {
  /** 本轮是「目标自动续跑轮」（user/message 的 source.kind === 'goal'） */
  goalRound: boolean;
  /** 本轮调用过 update_goal 收尾（complete / blocked） */
  closing: 'complete' | 'blocked' | null;
}

export interface WorkSnapshot {
  level: WorkLevel | null;
  /** 任务详情（来自 todo/write，可空） */
  task: string | null;
  /** 最近一次变化的时间戳 */
  ts: number;
}

/** turn/end 的 reason.kind → 落哪一档；null = 该回合已结束但无需展示 */
function levelForTurnEnd(kind: string, turn: TurnFlags | undefined, goalAware: boolean): WorkLevel | null {
  if (kind === 'completed') {
    if (!goalAware || !turn?.goalRound) return 'success';
    if (turn.closing === 'blocked') return 'error'; // 目标被阻塞结束：诚实地表沮丧，不庆祝
    if (turn.closing === 'complete') return 'success'; // 整个目标达成
    return 'result'; // 只是自动续跑的中间轮完成，不算任务完成
  }
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  if (kind === 'blocked') return 'waiting';
  return null; // aborted / interrupted 等：回合结束，清条目
}

/** update_goal 的 arguments（JSON 字符串）→ 收尾动作；非收尾返回 null */
export function goalClosingAction(args: unknown): 'complete' | 'blocked' | null {
  if (typeof args !== 'string') return null;
  try {
    const o = JSON.parse(args) as { action?: unknown } | null;
    const action = String(o?.action ?? '');
    if (action === 'complete' || action === 'blocked') return action;
  } catch {
    /* 非法 JSON：按未收尾处理 */
  }
  return null;
}

/** todo 清单 → 当前该展示的任务文案（取最后一个 in_progress，否则第一个 pending） */
export function taskFromTodos(todos: unknown): string | null {
  const list = Array.isArray(todos) ? (todos as Array<{ status?: unknown; content?: unknown }>) : [];
  let current: { status?: unknown; content?: unknown } | undefined;
  for (const t of list) if (t?.status === 'in_progress') current = t;
  if (!current) current = list.find((t) => t?.status === 'pending');
  const content = String(current?.content ?? '').trim();
  if (!content) return null;
  const points = Array.from(content); // 按码点切，别把 emoji 截成半个
  return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join('')}…` : content;
}

/** 等用户答复的工具：触发它 = 在等你，不是普通干活 */
const USER_QUESTION_TOOL = 'ask_user_question';
const GOAL_UPDATE_TOOL = 'update_goal';

export interface WorkStatusOptions {
  /** 是否启用 goal 续跑轮判定（默认开） */
  goalAware?: boolean;
  /** 终态展示时长 */
  terminalTtlMs?: number;
  /** 快照变化回调 */
  onChange?: (snapshot: WorkSnapshot) => void;
}

/**
 * 工作状态聚合器。
 * 用法：`apply(sessionId, event)`；有变化时会触发 onChange（index.ts 据此推给宠物）。
 */
export class WorkStatusTracker {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly turns = new Map<string, TurnFlags>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly snapshot: WorkSnapshot = { level: null, task: null, ts: 0 };
  private readonly goalAware: boolean;
  private readonly ttl: number;
  private onChange: ((s: WorkSnapshot) => void) | undefined;
  private seqCounter = 0;

  constructor(options: WorkStatusOptions = {}) {
    this.goalAware = options.goalAware !== false;
    this.ttl = options.terminalTtlMs ?? TERMINAL_TTL_MS;
    this.onChange = options.onChange;
  }

  setOnChange(cb: (s: WorkSnapshot) => void): void {
    this.onChange = cb;
  }

  current(): WorkSnapshot {
    return this.snapshot;
  }

  /**
   * 喂一条会话事件。
   * @returns 展示快照是否发生变化
   */
  apply(sessionId: string, event: SessionEvent): boolean {
    const type = event?.type;
    if (!type) return false;
    const seq = Number.isFinite(event.seq) ? Number(event.seq) : ++this.seqCounter;

    if (type === 'todo/write') {
      // 只更新「有活动条目」的会话：空闲会话写进来只会变成一条永不消失的幽灵文案
      if (!this.sessions.has(sessionId)) return false;
      return this.setTask(sessionId, taskFromTodos(event.data?.todos));
    }

    if (type === 'user/message') {
      if (this.goalAware && event.data?.source?.kind === 'goal') this.flags(sessionId).goalRound = true;
      return false;
    }

    if (type === 'turn/start') {
      this.turns.set(sessionId, { goalRound: false, closing: null });
      this.setTask(sessionId, null); // 新一轮清掉上一轮的任务文案
    }

    if (type === 'tool/call' && String(event.data?.name ?? '') === GOAL_UPDATE_TOOL) {
      const action = goalClosingAction(event.data?.arguments);
      if (action) this.flags(sessionId).closing = action;
    }

    let level: WorkLevel | null;
    switch (type) {
      case 'turn/start':
        level = 'thinking';
        break;
      case 'tool/call':
        level = String(event.data?.name ?? '') === USER_QUESTION_TOOL ? 'waiting' : 'working';
        break;
      case 'tool/result':
        level = 'result';
        break;
      case 'approval/asked':
        level = 'waiting';
        break;
      case 'turn/end':
        level = levelForTurnEnd(String(event.data?.reason?.kind ?? ''), this.turns.get(sessionId), this.goalAware);
        break;
      default:
        return false; // 其它事件不驱动档位
    }

    if (level === null) {
      // 回合结束但无需展示（用户取消等）：清掉该会话，免得永久卡在上一档
      this.turns.delete(sessionId);
      this.cancelTimer(sessionId);
      return this.clear(sessionId);
    }
    return this.setLevel(sessionId, level, seq);
  }

  /** 插件卸载时清掉所有定时器 */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.sessions.clear();
    this.turns.clear();
  }

  // ------------------------------------------------------------ 内部 --

  private flags(sessionId: string): TurnFlags {
    let f = this.turns.get(sessionId);
    if (!f) {
      f = { goalRound: false, closing: null };
      this.turns.set(sessionId, f);
    }
    return f;
  }

  private setLevel(sessionId: string, level: WorkLevel, seq: number): boolean {
    const prev = this.sessions.get(sessionId);
    if (prev && prev.level === level && prev.seq >= seq) return false;
    this.sessions.set(sessionId, { level, seq, task: prev?.task ?? null });
    this.refresh();
    if (level === 'success' || level === 'error') this.scheduleTerminalCleanup(sessionId);
    else this.cancelTimer(sessionId);
    return true;
  }

  private setTask(sessionId: string, task: string | null): boolean {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.task === task) return false;
    this.sessions.set(sessionId, { ...prev, task });
    this.refresh();
    return true;
  }

  private clear(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    this.refresh();
    return true;
  }

  private scheduleTerminalCleanup(sessionId: string): void {
    this.cancelTimer(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      // 到点时该会话若已不是终态，就什么都不做（避免误清进行中的状态）
      const entry = this.sessions.get(sessionId);
      if (entry && (entry.level === 'success' || entry.level === 'error')) this.clear(sessionId);
    }, this.ttl);
    // 别让这个定时器拖住进程退出
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(sessionId, timer);
  }

  private cancelTimer(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(sessionId);
    }
  }

  /** 重算展示快照：优先级最高者胜出，同级取更近的 seq */
  private refresh(): void {
    let bestId: string | null = null;
    let best: SessionEntry | null = null;
    for (const [id, entry] of this.sessions) {
      if (!best || PRIORITY[entry.level] > PRIORITY[best.level] || (PRIORITY[entry.level] === PRIORITY[best.level] && entry.seq > best.seq)) {
        best = entry;
        bestId = id;
      }
    }
    const nextLevel = best?.level ?? null;
    const nextTask = best?.task ?? null;
    if (nextLevel === this.snapshot.level && nextTask === this.snapshot.task) return;
    this.snapshot.level = nextLevel;
    this.snapshot.task = nextTask;
    this.snapshot.ts = Date.now();
    this.onChange?.(this.snapshot);
  }
}
