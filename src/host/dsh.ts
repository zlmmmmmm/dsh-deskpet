/**
 * 与 DSH 宿主交互时用到的最小接口声明。
 *
 * 为什么自己声明而不 import @deepseek-ai/* 的类型：
 *   本插件只需要 webServer / 事件订阅 / effect 清理 这三样能力，而 DSH 的插件包
 *   目前是 0.2.0-rc 阶段、类型包版本变动频繁。自己钉住用到的这几个形状，
 *   可以让本包做到**零运行时依赖**（宿主提供一切），也不会因为上游类型改名而装不上。
 *   形状抄自 DSH 现有插件的实际调用方式。
 */

/** 路由请求（只用 Node 的 IncomingMessage 子集） */
export interface DshRequest {
  url?: string;
  method?: string;
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

/** 路由响应（只用 Node 的 ServerResponse 子集） */
export interface DshResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

export interface DshLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

/** 本插件用到的宿主上下文 */
export interface DshCtx {
  /** DSH 的 HTTP 服务：注册一个前缀路由 */
  webServer: {
    register(route: {
      kind: 'prefix';
      path: string;
      handler: (req: DshRequest, res: DshResponse) => void | Promise<void>;
    }): () => void;
  };
  /** 宿主事件订阅，返回取消订阅函数 */
  on(event: string, cb: (...args: unknown[]) => void): () => void;
  /** 生命周期：fn 的返回值（若有）在插件卸载时调用 */
  effect(fn: () => void | (() => void), label?: string): void;
  logger?: DshLogger;
}

/** DSH 会话对象（只取 id） */
export interface DshSession {
  id?: unknown;
  header?: { id?: unknown };
}
