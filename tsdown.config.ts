/**
 * 构建配置（tsdown）
 * ============================================================================
 * 两个入口，两种格式：
 *   1. 宿主半侧 src/host/index.ts → lib/index.js（ESM，平台 node）
 *      由 DSH 的 cordis 加载器 import，运行在宿主进程里。
 *   2. 客户端半侧 src/client/index.ts → lib/client.js（IIFE，平台 browser）
 *      必须是「普通副作用脚本」：加载时调用 window.__ModuleLoader__.load，
 *      自身零 export（所以不需要 output.name）。
 *
 * React / @deepseek-ai/* 一律 neverBundle：它们由 DSH 在运行时注入，
 * 打进包里会和宿主的那份冲突。
 */
import { defineConfig } from 'tsdown';

const shared = {
  outDir: 'lib',
  dts: false,
  clean: false,
  // 默认会产出 .mjs，而 package.json 的 main / exports 指的是 .js
  outExtensions: () => ({ js: '.js' }),
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/host/index.ts' },
    format: 'esm',
    platform: 'node',
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    ...shared,
    entry: { client: 'src/client/index.ts' },
    format: 'iife',
    platform: 'browser',
    // iife 格式默认会产出 client.iife.js，而 DSH 按 package.json 的 exports 取 lib/client.js
    outputOptions: { entryFileNames: 'client.js' },
    deps: { neverBundle: ['react', 'react/jsx-runtime', /^@deepseek-ai\//] },
  },
]);
