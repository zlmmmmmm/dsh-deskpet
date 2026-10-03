'use strict';
/**
 * 宿主 → 宠物 的命令通道：**本机 HTTP 回调服务器**。
 *
 * ============================================================================
 * 为什么不用 stdin（这是踩过的坑，别再走回头路）
 *   Electron 主进程在 Windows 上收不到 piped stdin（electron#4218）。
 *   实测：宿主用 spawn 的管道写命令，helper 的 process.stdin 立刻收到 'end'，
 *   一条 'data' 都没有；即便把 stdin 重定向成真实文件句柄也一样（已做过对照实验：
 *   同样的重定向方式下，纯 Node 进程能正常读到内容）。所以宿主 → 助手这一向
 *   绝不能走 0 号管道。
 *
 * 采用的方案（与 dsh-pet 的 bridge 回调同构）：
 *   1. helper 启动时监听 127.0.0.1 的随机端口
 *   2. 通过 stdout 的 ready 事件把 callback 地址告诉宿主
 *   3. 宿主 POST /cmd 把命令送进来
 *   stdout 只用于 helper → 宿主 方向（写是好的），两边方向都各有一个可靠通道。
 *
 * 安全：只绑 127.0.0.1 + 随机端口，且只暴露 /cmd 与 /health 两个只读/受控端点。
 */
const http = require('node:http');

const MAX_BODY = 1 << 20; // 1MB 上限，防止畸形请求把内存吃满

/**
 * @param {(msg: any) => void} onCommand 收到一条命令（已 JSON 解析）
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{url: string, port: number, close: () => void} | null>}
 */
function startCommandServer(onCommand, onLog = () => {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && req.url === '/cmd') {
        let body = '';
        let aborted = false;
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY) {
            aborted = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (aborted) return;
          let msg;
          try {
            msg = JSON.parse(body);
          } catch {
            onLog(`命令不是合法 JSON：${body.slice(0, 120)}`);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"ok":false,"error":"bad json"}');
            return;
          }
          try {
            onCommand(msg);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
          } catch (err) {
            onLog(`命令执行失败：${err && err.message}`);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"ok":false}');
          }
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    server.on('error', (err) => {
      onLog(`命令服务器启动失败：${err && err.message}`);
      resolve(null);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      onLog(`命令服务器就绪：${url}`);
      resolve({
        url,
        port,
        close: () => {
          try {
            server.close();
          } catch {
            /* 关不掉也无所谓，进程退出会回收 */
          }
        },
      });
    });
  });
}

/**
 * 把一条命令 POST 给 helper（宿主侧用；开发脚本也用它）。
 * @param {string} baseUrl helper 上报的 callback 地址
 * @param {any} msg
 */
async function postCommand(baseUrl, msg) {
  const res = await fetch(`${baseUrl}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`POST /cmd 失败：HTTP ${res.status}`);
  return res.json();
}

module.exports = { startCommandServer, postCommand };
