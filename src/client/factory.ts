/**
 * 插件 factory：DSH 的模块系统会调用它，并注入 `require`。
 * 与 src/client/index.ts 分开，是为了让 index.ts 保持「零 export 的副作用脚本」——
 * IIFE 产物一旦有 export 就得指定全局名，而我们的客户端半侧不需要对外暴露任何东西。
 */
import type * as ReactNS from 'react';
import { makeSettingsSection } from './settings.js';

const API = '/dsh-deskpet';

/**
 * 手写 createElement 包装：让设置页可以 `h('div', props, a, b, c)` 变长传子节点。
 * 不用 react/jsx-runtime 是为了避免 JSX 编译产出静态 import（那会把 React 打进包里，
 * 而 React 必须由 DSH 在运行时注入）。
 * 返回值在对调用方处断言成 React.createElement 的类型，这样设置页里的事件回调
 * 能吃到 React 的重载推导（类型只在编译期，运行时没有任何 React 导入）。
 */
function createH(React: { createElement: (...args: never[]) => unknown }) {
  return function h(type: unknown, props?: unknown, ...children: unknown[]): unknown {
    const p: Record<string, unknown> = props ? { ...(props as Record<string, unknown>) } : {};
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
    if (flat.length === 1) p.children = flat[0];
    else if (flat.length > 1) p.children = flat;
    return React.createElement(type as never, p as never);
  };
}

interface ClientSlots {
  inject(slot: string, gen: () => Generator<unknown>): unknown;
  register(info: Record<string, unknown>, comp: unknown): unknown;
}

interface ClientCtx {
  slots: ClientSlots;
  effect(fn: () => void | (() => void), label?: string): void;
  logger?: { info?(msg: string): void; warn?(msg: string): void };
}

/** 返回 DSH 插件 factory：`(require) => module`，module 上是 name/inject/apply 三件套 */
export function makeFactory(): (require: (mod: string) => unknown) => unknown {
  return (require) => {
    const module = { exports: {} as Record<string, unknown> };
    const React = require('react') as typeof ReactNS;
    const h = createH(React as unknown as { createElement: (...args: never[]) => unknown }) as unknown as typeof ReactNS.createElement;
    const SettingsSection = makeSettingsSection({
      h,
      useState: React.useState,
      useEffect: React.useEffect,
    });

    const name = 'deskpet';
    const inject = ['slots'];

    function apply(ctx: ClientCtx): void {
      // 焦点上报：宠物据此决定「要不要额外弹系统通知打扰你」。
      // 放在 apply 里而不是设置页组件里——组件只在设置页打开时才挂载。
      ctx.effect(() => {
        const report = (): void => {
          const focused = document.hasFocus() && document.visibilityState === 'visible';
          void fetch(`${API}/focus`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ focused }),
          }).catch(() => {
            /* 宿主没起来时静默失败，不影响页面其余功能 */
          });
        };
        report();
        const onVis = (): void => report();
        window.addEventListener('focus', report);
        window.addEventListener('blur', report);
        document.addEventListener('visibilitychange', onVis);
        return () => {
          window.removeEventListener('focus', report);
          window.removeEventListener('blur', report);
          document.removeEventListener('visibilitychange', onVis);
        };
      }, 'dsh-deskpet: focus reporter');

      // 设置页区块
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'deskpet', order: 35, label: () => '桌面宠物' },
          SettingsSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
