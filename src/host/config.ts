/**
 * 配置与形象清单（宿主侧，纯逻辑，无第三方依赖）
 * ============================================================================
 * 配置三层，优先级从低到高：
 *   1. 代码内置默认（本文件 BUILTIN）
 *   2. 包内 assets/config.jsonc（带注释的完整参考）
 *   3. 用户层 $DSH_HOME/dsh-deskpet/main-config.jsonc（运行时唯一会被写的那份）
 *
 * 原则（沿用整个项目的取向）：**配置是唯一事实来源，非法值显式告警并回落默认**，
 * 绝不因为一个坏字段让宠物消失，也绝不静默吞掉整份配置。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- 类型 ----

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PetPosition {
  corner: Corner;
  marginX: number;
  marginY: number;
}

export interface PetConfig {
  id: string;
  name: string;
  /** 形象 id（对应 assets/pet/<id>/ 或用户 pet/<id>/） */
  species: string;
  /** 宠物宽度（CSS px / DIP） */
  size: number;
  position: PetPosition;
}

export interface RoamConfig {
  minDist: number;
  maxDist: number;
  speed: number;
  pauseMinSec: number;
  pauseMaxSec: number;
}

export interface PhysicsConfig {
  gravity: number;
  restitution: number;
  groundFriction: number;
  throwPower: number;
}

export interface DeskPetConfig {
  pets: PetConfig[];
  roamEnabled: boolean;
  roam: RoamConfig;
  workStatusEnabled: boolean;
  notifyEnabled: boolean;
  notifySystemToast: boolean;
  clickToFocusDsh: boolean;
  physics: PhysicsConfig;
  /** 工作状态气泡文案：外层索引 = 档位（thinking/working/result/waiting/success/error） */
  workStatusTexts: string[][];
}

export interface SpeciesEntry {
  id: string;
  name: string;
  /** 素材绝对路径（宿主会把它写进给助手的配置里，助手不再猜相对路径） */
  file: string;
  width: number;
  height: number;
  /** 高 / 宽，助手据此算精灵高度 */
  heightRatio: number;
  /** 'package' = 随插件发布；'user' = 用户自建 pet pack */
  origin: 'package' | 'user';
}

export const WORK_LEVELS = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
/** 工作状态档位（真正的聚合逻辑在 work-status.ts，这里只给配置校验用） */
export type WorkLevel = (typeof WORK_LEVELS)[number];

// ------------------------------------------------------------ JSONC ----

/** 剥掉 JSONC 的注释（字符串内的 // 与 /* 不动） */
export function stripJsonc(text: string): string {
  // 先去掉 UTF-8 BOM：记事本 / PowerShell 的 Set-Content(UTF8) 都会加，
  // 而 JSON.parse 遇到 BOM 会直接抛 "Unexpected token"——用户手改配置后必定踩到。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}

// ---------------------------------------------------------- 默认值 ----

export const BUILTIN: DeskPetConfig = {
  pets: [
    {
      id: 'main',
      name: '阿狐',
      species: 'foxboy',
      size: 190,
      position: { corner: 'bottom-right', marginX: 24, marginY: 24 },
    },
  ],
  roamEnabled: true,
  roam: { minDist: 80, maxDist: 260, speed: 70, pauseMinSec: 8, pauseMaxSec: 22 },
  workStatusEnabled: true,
  notifyEnabled: true,
  notifySystemToast: true,
  clickToFocusDsh: true,
  physics: { gravity: 2400, restitution: 0.55, groundFriction: 3.4, throwPower: 1 },
  workStatusTexts: [
    ['正在想呢…'],
    ['正在干活，别打扰我～'],
    ['搞定一步，继续～'],
    ['轮到你来决定啦，等你～'],
    ['这一轮搞定啦！'],
    ['好像卡住了呢…'],
  ],
};

const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// ---------------------------------------------------------- 归一化 ----

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim() : d);

export interface NormalizeResult {
  config: DeskPetConfig;
  warnings: string[];
}

/**
 * 把任意来源的对象归一化成合法配置。
 * @param raw 原始对象（包内默认与用户层已合并过，或其中任一）
 */
export function normalizeConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const rawPets = Array.isArray(src.pets) ? src.pets : [];
  const pets: PetConfig[] = [];
  const seen = new Set<string>();
  for (const [i, p] of rawPets.entries()) {
    if (!p || typeof p !== 'object') {
      warnings.push(`pets[${i}] 不是对象，已跳过`);
      continue;
    }
    const o = p as Record<string, unknown>;
    const id = str(o.id, '');
    if (!id) {
      warnings.push(`pets[${i}] 缺少 id，已跳过`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      warnings.push(`pets[${i}].id="${id}" 含非法字符（只允许字母数字下划线连字符），已跳过`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`pets[${i}].id="${id}" 与前面的重复，已跳过`);
      continue;
    }
    seen.add(id);
    const pos = (o.position && typeof o.position === 'object' ? o.position : {}) as Record<string, unknown>;
    const corner = CORNERS.includes(pos.corner as Corner) ? (pos.corner as Corner) : 'bottom-right';
    if (pos.corner !== undefined && !CORNERS.includes(pos.corner as Corner)) {
      warnings.push(`pets[${i}].position.corner="${String(pos.corner)}" 非法，回落 bottom-right`);
    }
    pets.push({
      id,
      name: str(o.name, id),
      species: str(o.species, 'foxboy'),
      size: Math.max(64, Math.round(num(o.size, 190))),
      position: { corner, marginX: num(pos.marginX, 24), marginY: num(pos.marginY, 24) },
    });
  }
  if (!pets.length) {
    if (rawPets.length) warnings.push('pets 里没有一条合法配置，已回落内置默认宠物');
    pets.push(...BUILTIN.pets.map((p) => ({ ...p, position: { ...p.position } })));
  }

  const roamRaw = (src.roam && typeof src.roam === 'object' ? src.roam : {}) as Record<string, unknown>;
  const physRaw = (src.physics && typeof src.physics === 'object' ? src.physics : {}) as Record<string, unknown>;

  const texts = Array.isArray(src.workStatusTexts)
    ? src.workStatusTexts
        .filter(Array.isArray)
        .map((row) => (row as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== ''))
    : BUILTIN.workStatusTexts;

  return {
    config: {
      pets,
      roamEnabled: bool(src.roamEnabled, BUILTIN.roamEnabled),
      roam: {
        minDist: Math.max(0, num(roamRaw.minDist, BUILTIN.roam.minDist)),
        maxDist: Math.max(0, num(roamRaw.maxDist, BUILTIN.roam.maxDist)),
        speed: Math.max(1, num(roamRaw.speed, BUILTIN.roam.speed)),
        pauseMinSec: Math.max(0, num(roamRaw.pauseMinSec, BUILTIN.roam.pauseMinSec)),
        pauseMaxSec: Math.max(0, num(roamRaw.pauseMaxSec, BUILTIN.roam.pauseMaxSec)),
      },
      workStatusEnabled: bool(src.workStatusEnabled, BUILTIN.workStatusEnabled),
      notifyEnabled: bool(src.notifyEnabled, BUILTIN.notifyEnabled),
      notifySystemToast: bool(src.notifySystemToast, BUILTIN.notifySystemToast),
      clickToFocusDsh: bool(src.clickToFocusDsh, BUILTIN.clickToFocusDsh),
      physics: {
        gravity: Math.max(0, num(physRaw.gravity, BUILTIN.physics.gravity)),
        restitution: Math.min(1, Math.max(0, num(physRaw.restitution, BUILTIN.physics.restitution))),
        groundFriction: Math.max(0, num(physRaw.groundFriction, BUILTIN.physics.groundFriction)),
        throwPower: Math.max(0.05, num(physRaw.throwPower, BUILTIN.physics.throwPower)),
      },
      workStatusTexts: texts.length ? texts : BUILTIN.workStatusTexts,
    },
    warnings,
  };
}

/** 浅合并：用户层只覆盖它写了的顶层字段（pets 数组整体覆盖） */
export function mergeLayers(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (k === 'roam' || k === 'physics') {
      const b = (base[k] && typeof base[k] === 'object' ? base[k] : {}) as Record<string, unknown>;
      out[k] = { ...b, ...(v && typeof v === 'object' ? v : {}) };
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------- 读写 ----

export interface ConfigPaths {
  /** 包内 assets 目录 */
  assetsDir: string;
  /** 用户数据根目录（$DSH_HOME/dsh-deskpet） */
  userRoot: string;
}

export const USER_CONFIG_NAME = 'main-config.jsonc';

export function userConfigPath(userRoot: string): string {
  return join(userRoot, USER_CONFIG_NAME);
}

function readJsoncFile(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return parseJsonc<Record<string, unknown>>(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} 解析失败：${(err as Error).message}`);
  }
}

export interface LoadedConfig extends NormalizeResult {
  /** 用户层文件是否存在（决定设置页提示语） */
  hasUserConfig: boolean;
}

/**
 * 载入并合并配置。用户层损坏时**不静默**：把错误抛给调用方去告警，
 * 同时回落到包内默认继续跑（宠物不该因为配置写坏了就消失）。
 */
export function loadConfig(paths: ConfigPaths): LoadedConfig {
  let base: Record<string, unknown> = {};
  try {
    base = readJsoncFile(join(paths.assetsDir, 'config.jsonc')) ?? {};
  } catch (err) {
    return { ...normalizeConfig({}), hasUserConfig: existsSync(userConfigPath(paths.userRoot)), warnings: [(err as Error).message] };
  }

  const userFile = userConfigPath(paths.userRoot);
  let over: Record<string, unknown> | null = null;
  const warnings: string[] = [];
  try {
    over = readJsoncFile(userFile);
  } catch (err) {
    warnings.push(`${(err as Error).message}（已忽略用户层，使用包内默认）`);
  }

  const merged = over ? mergeLayers(base, over) : base;
  const normalized = normalizeConfig(merged);
  return { ...normalized, warnings: [...warnings, ...normalized.warnings], hasUserConfig: over !== null };
}

/** 把配置写入用户层（唯一会被运行时改写的那份） */
export function saveConfig(userRoot: string, config: DeskPetConfig): void {
  mkdirSync(userRoot, { recursive: true });
  const header =
    '// dsh-deskpet 用户配置（由设置页 / 右键菜单写入，可直接手改）\n' +
    '// 完整字段说明见插件包内 assets/config.jsonc；这里没写的字段取内置默认。\n';
  writeFileSync(userConfigPath(userRoot), header + JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------ 形象清单 ----

/** 读 PNG 的 IHDR 拿宽高（不用任何图像库） */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 扫描一个「形象根目录」下的所有物种：`<root>/<id>/idle.png`，可选
 * `<root>/<id>/species.json` 提供显示名。零配置即可加新形象（拖个文件夹进去就行）。
 */
function scanSpeciesRoot(root: string, origin: 'package' | 'user', out: Map<string, SpeciesEntry>): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const id of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const img = join(dir, 'idle.png');
    if (!existsSync(img)) continue;
    let width = 0;
    let height = 0;
    try {
      const size = pngSize(readFileSync(img));
      if (size) {
        width = size.width;
        height = size.height;
      }
    } catch {
      /* 读不了就当未知尺寸，下面用兜底比例 */
    }
    let name = id;
    const meta = join(dir, 'species.json');
    if (existsSync(meta)) {
      try {
        const o = parseJsonc<Record<string, unknown>>(readFileSync(meta, 'utf8'));
        name = str(o.name, id);
        width = Math.round(num(o.width, width));
        height = Math.round(num(o.height, height));
      } catch {
        /* 元数据坏了不影响出图 */
      }
    }
    const heightRatio = height > 0 && width > 0 ? Number((height / width).toFixed(4)) : 1.8;
    out.set(id, { id, name, file: img, width, height, heightRatio, origin });
  }
}

/**
 * 汇总可用形象：**包内先扫、用户目录后扫**，用户同名形象覆盖包内（方便用户改图不改 id）。
 */
export function discoverSpecies(paths: ConfigPaths): SpeciesEntry[] {
  const map = new Map<string, SpeciesEntry>();
  scanSpeciesRoot(join(paths.assetsDir, 'pet'), 'package', map);
  scanSpeciesRoot(join(paths.userRoot, 'pet'), 'user', map);
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 把配置里引用的、清单里不存在的形象修正到第一个可用形象（避免"配错一个 id 宠物就没了"）。
 */
export function reconcileSpecies(config: DeskPetConfig, species: SpeciesEntry[]): { config: DeskPetConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!species.length) return { config, warnings: ['没有发现任何形象素材（assets/pet/<id>/idle.png）'] };
  const fallback = species[0] as SpeciesEntry;
  const pets = config.pets.map((p) => {
    if (species.some((s) => s.id === p.species)) return p;
    warnings.push(`宠物 "${p.id}" 的形象 "${p.species}" 不存在，回落 "${fallback.id}"`);
    return { ...p, species: fallback.id };
  });
  return { config: { ...config, pets }, warnings };
}
