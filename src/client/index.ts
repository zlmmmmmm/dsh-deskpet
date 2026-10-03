/**
 * 客户端半侧外壳（构建为 lib/client.js）
 * ============================================================================
 * 必须是「普通副作用脚本」：加载时调用 window.__ModuleLoader__.load，
 * 且**不含任何顶层 export / import**（React 由 factory 的 require 在运行时取）。
 * 本文件刻意只有副作用，factory 在 ./factory.ts。
 *
 * 本半侧只做两件事：
 *   1. 在设置页挂「桌面宠物」区块
 *   2. 持续上报 DSH 窗口焦点（宠物只在你不看 DSH 时才弹系统通知）
 * 宠物本体完全不在浏览器里——它住在独立的桌面窗口进程中。
 */
import { makeFactory } from './factory.js';

declare const window: {
  __ModuleLoader__: {
    load(info: { id: string; factory: (require: (m: string) => unknown) => unknown }): void;
  };
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
};

window.__ModuleLoader__.load({ id: 'dsh-deskpet', factory: makeFactory() });
