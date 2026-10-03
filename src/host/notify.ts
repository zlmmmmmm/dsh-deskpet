/**
 * 提醒帧生成（宿主侧纯逻辑）
 * ============================================================================
 * 把 DSH 的事件映射成「要让宠物告诉你的一句话」。与工作状态是两件事：
 *   工作状态 = 宠物此刻摆什么姿势（连续态，聚合）
 *   提醒     = 一件值得你抬头看的事（离散事件，一条一条）
 *
 * 映射来源（`session/event` + `agent/error`）：
 *   turn/end  completed   → 干完了
 *             error       → 出错了
 *             max-tokens  → 输出被截断
 *   approval/asked        → 等你批准某个工具
 *   tool/call ask_user_question → 等你回答问题
 *   agent/error           → 无回合位置的失败
 *
 * 注意：aborted / interrupted / blocked 不产生提醒（前者是你自己取消的，后者紧跟着 approval 提醒）。
 */

export type NoticeKind = 'done' | 'error' | 'truncated' | 'approval' | 'question';

/** 气泡配色档（与 styles.css 的 #bubble.<level> 对应） */
export type NoticeLevel = 'success' | 'error' | 'attention' | 'info';

export interface PetNotice {
  kind: NoticeKind;
  /** 气泡主文案（一句话，要短） */
  text: string;
  /** 补充细节（工具名 / 错误摘要 / 问题原文），可为空 */
  detail?: string;
  level: NoticeLevel;
  /** 是否值得弹系统通知（打扰级别：完成/出错/等你确认都值得，截断也值得） */
  toast: boolean;
}

/** 详情文案上限，别让气泡炸开 */
const DETAIL_MAX = 80;

function clip(s: string, max = DETAIL_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const points = Array.from(t);
  return points.length > max ? `${points.slice(0, max).join('')}…` : t;
}

const USER_QUESTION_TOOL = 'ask_user_question';

export interface SessionEventLike {
  type?: string;
  data?: {
    name?: unknown;
    arguments?: unknown;
    toolName?: unknown;
    reason?: { kind?: unknown; error?: { message?: unknown } };
    [k: string]: unknown;
  };
}

/**
 * 一条 session/event → 提醒；不关心的事件返回 null。
 */
export function noticeFromEvent(event: SessionEventLike): PetNotice | null {
  if (!event?.type) return null;
  switch (event.type) {
    case 'turn/end': {
      const reason = event.data?.reason;
      const kind = String(reason?.kind ?? '');
      if (kind === 'completed') {
        return { kind: 'done', text: '这一轮搞定啦！', level: 'success', toast: true };
      }
      if (kind === 'error') {
        const msg = String(reason?.error?.message ?? '');
        return { kind: 'error', text: '刚才这一步出错了…', detail: msg ? clip(msg) : undefined, level: 'error', toast: true };
      }
      if (kind === 'max-tokens') {
        return { kind: 'truncated', text: '输出太长被截断了', level: 'attention', toast: true };
      }
      return null; // aborted / interrupted / blocked：不打扰
    }
    case 'approval/asked': {
      const tool = String(event.data?.toolName ?? '');
      const reason = String(event.data?.reason ?? '');
      return {
        kind: 'approval',
        text: '需要你确认一下～',
        detail: clip(tool || reason) || undefined,
        level: 'attention',
        toast: true,
      };
    }
    case 'tool/call': {
      if (String(event.data?.name ?? '') !== USER_QUESTION_TOOL) return null;
      const q = firstQuestion(event.data?.arguments);
      return { kind: 'question', text: '有个问题等你回答', detail: q ? clip(q) : undefined, level: 'attention', toast: true };
    }
    default:
      return null;
  }
}

/** ask_user_question 的 arguments（JSON 字符串）→ 第一个问题原文 */
export function firstQuestion(args: unknown): string | null {
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args) as { questions?: Array<{ question?: unknown }> } | null;
    const list = parsed?.questions;
    if (!Array.isArray(list) || !list.length) return null;
    const q = String(list[0]?.question ?? '').trim();
    return q || null;
  } catch {
    return null;
  }
}

/** `agent/error`（没有回合位置的失败）→ 提醒 */
export function noticeFromAgentError(error: unknown): PetNotice {
  const msg = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return { kind: 'error', text: '出错了，看一下？', detail: msg ? clip(msg) : undefined, level: 'error', toast: true };
}
