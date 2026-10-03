#!/usr/bin/env node
/**
 * 小工具：改用户配置里某个宠物的字段（默认把 size 修回 190）。
 * 用法：node scripts/fix-pet-size.mjs [新尺寸]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const size = Number(process.argv[2] || 190);
const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-deskpet', 'main-config.jsonc');
const text = readFileSync(file, 'utf8');
const next = text.replace(/"size":\s*\d+/, `"size": ${size}`);
writeFileSync(file, next, 'utf8');
console.log(`changed=${text !== next}`);
console.log(next.split('\n').filter((l) => l.includes('"size"') || l.includes('"species"')).join('\n'));
