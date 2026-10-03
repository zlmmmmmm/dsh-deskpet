#!/usr/bin/env node
/**
 * BOM 容错自测：配置文件被记事本 / PowerShell Set-Content(UTF8) 加上 BOM 后，
 * 解析必须照常成功（否则用户手改一次配置，宠物就回落到默认值，而且很难查）。
 *
 * 用法：node scripts/test-bom.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = require('../runtime/electron-helper/config.js');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name} —— ${err.message}`);
    fail++;
  }
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('助手侧 parseJsonc：');
const body = '{ // 注释\n  "pets": [ { "id": "main" } ]\n}';
check('纯 JSONC（无 BOM）', () => {
  const o = helper.parseJsonc(body);
  assert(o.pets[0].id === 'main', '解析结果不对');
});
check('带 BOM', () => {
  const o = helper.parseJsonc('\uFEFF' + body);
  assert(o.pets[0].id === 'main', 'BOM 导致解析结果不对');
});
check('带 BOM + 字符串里含 //', () => {
  const o = helper.parseJsonc('\uFEFF{ "url": "http://x//y", "n": 1 }');
  assert(o.url === 'http://x//y' && o.n === 1, '字符串里的 // 被误当注释');
});
check('带 BOM 的真实配置文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-bom-'));
  const f = join(dir, 'c.jsonc');
  writeFileSync(f, '\uFEFF' + body, 'utf8');
  const o = helper.parseJsonc(readFileSync(f, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  assert(o.pets[0].id === 'main', '文件解析失败');
});
check('转义引号不被注释逻辑吃掉', () => {
  const o = helper.parseJsonc('{ "s": "a\\"b//c" }');
  assert(o.s === 'a"b//c', `得到 ${JSON.stringify(o.s)}`);
});

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 1 * 0 : 1);
