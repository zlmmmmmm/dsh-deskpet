#!/usr/bin/env node
/**
 * 假 DSH 宿主：把构建产物 lib/index.js 当成真插件加载起来驱动。
 *
 * 为什么需要它：真装进 DSH 必须重启 DSH，而这个会话本身跑在 DSH 里——重启就等于
 * 把自己掐了。所以用这个最小宿主复刻 DSH 提供给插件的三样东西
 * （webServer.register / ctx.on / ctx.effect），其余全部走真实代码路径：
 * 真配置、真形象扫描、真 spawn Electron、真命令通道、真事件映射。
 *
 * 用法：
 *   node scripts/dev-host-harness.mjs
 * 然后对它发控制请求（PowerShell 示例）：
 *   # 插件真实路由
 *   Invoke-RestMethod http://127.0.0.1:<port>/dsh-deskpet/config
 *   # 驱动会话事件（模拟 DSH）
 *   Invoke-RestMethod -Method Post http://127.0.0.1:<port>/ctl/event -ContentType application/json `
 *     -Body '{"session":"s1","event":{"type":"turn/start"}}'
 *   Invoke-RestMethod -Method Post http://127.0.0.1:<port>/ctl/event -ContentType application/json `
 *     -Body '{"session":"s1","event":{"type":"turn/end","data":{"reason":{"kind":"completed"}}}}'
 *   Invoke-RestMethod -Method Post http://127.0.0.1:<port>/ctl/focus -ContentType application/json -Body '{"focused":false}'
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENTRY = join(ROOT, 'lib', 'index.js');

const mod = await import(pathToFileURL(ENTRY).href);
console.log(`[harness] 已加载插件模块：name=${mod.name} inject=${JSON.stringify(mod.inject)}`);

/** DSH 提供的宿主能力（最小复刻） */
const routes = [];
const handlers = new Map();
const cleanups = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      console.log(`[harness] 插件注册路由：${route.kind} ${route.path}`);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  },
  on(event, cb) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(cb);
    return () => {
      const list = handlers.get(event) ?? [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  },
  effect(fn, label) {
    console.log(`[harness] effect 执行：${label ?? '(未命名)'}`);
    const c = fn();
    if (typeof c === 'function') cleanups.push(c);
  },
  logger: {
    info: (m) => console.log(`[host] ${m}`),
    warn: (m) => console.warn(`[host] ${m}`),
    error: (m) => console.error(`[host] ${m}`),
  },
};

mod.apply(ctx);

function emit(event) {
  const list = handlers.get('session/event') ?? [];
  if (!list.length) return 0;
  for (const cb of list) cb({ header: { id: event.__session ?? 'harness-session' } }, event.__event);
  return list.length;
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/ctl/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      try {
        const payload = body ? JSON.parse(body) : {};
        if (url === '/ctl/event') {
          const n = emit({ __session: payload.session ?? 'harness-session', __event: payload.event });
          send({ ok: n > 0, delivered: n });
          return;
        }
        if (url === '/ctl/agent-error') {
          for (const cb of handlers.get('agent/error') ?? []) cb(payload.message ?? 'harness error');
          send({ ok: true });
          return;
        }
        if (url === '/ctl/dispose') {
          for (const c of cleanups.splice(0)) c();
          send({ ok: true });
          return;
        }
        send({ error: 'unknown ctl endpoint' }, 404);
      } catch (err) {
        send({ error: String(err && err.message) }, 500);
      }
    });
    return;
  }

  for (const route of routes) {
    if (url.startsWith(route.path)) {
      route.handler(req, res);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no route');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`[harness] 就绪：http://127.0.0.1:${port}（插件路由 /dsh-deskpet/*，控制端点 /ctl/*）`);
console.log(`[harness] 控制示例：/ctl/event  /ctl/agent-error  /ctl/dispose`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('[harness] 收尾…');
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* 忽略 */
      }
    }
    server.close();
    process.exit(0);
  });
}
