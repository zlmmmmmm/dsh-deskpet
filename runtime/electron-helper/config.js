'use strict';
const fs = require('node:fs');
const path = require('node:path');
/**
 * 配置读取 + 几何计算（纯函数，不依赖 Electron，可单独测试）
 *
 * 坐标口径统一为 **DIP**（Electron 的默认坐标空间，= CSS px）：
 *   屏幕 2560×1600 @150% 缩放的机器上，workArea 报 1707×1067，两者一一对应，
 *   窗口按 DIP 摆放即自然正确，不需要 dsh-pet 那套 force-device-scale-factor
 *   线性化（那套是为了在「多屏异构缩放」下逐帧 setContentBounds 不漂移）。
 */

/** 精灵高宽比缺省值（height / width）：物种清单会给出真值，这里只做兜底 */
const DEFAULT_HEIGHT_RATIO = 1.85;

/** 窗口四周留白比例：给气泡、拖拽余量、落地 Q 弹留空间 */
const PAD_RATIO = {
  x: 0.18, // 左右各 0.18×size
  top: 0.55, // 头顶 0.55×size（气泡就画在这里）
  bottom: 0.1, // 脚下 0.10×size（落地回弹不裁切）
};

/**
 * 从 JSONC 文本里剥掉注释（够用即可：本插件的配置文件是机器写 + 人改的简单结构）。
 * @param {string} text
 * @returns {string}
 */
function stripJsonc(text) {
  // 去掉 UTF-8 BOM（记事本 / PowerShell Set-Content(UTF8) 会加，JSON.parse 遇到就抛错）
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
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
      if (c === '\\') {
        out += src[++i] ?? '';
      } else if (c === '"') {
        inStr = false;
      }
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

/** @param {string} text */
function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/** 代码内置默认（优先级最低，config.jsonc 里没写的字段落到这里） */
const BUILTIN = {
  pets: [
    {
      id: 'main',
      name: '桌宠',
      species: 'foxboy',
      size: 190,
      heightRatio: DEFAULT_HEIGHT_RATIO,
      position: { corner: 'bottom-right', marginX: 24, marginY: 24 },
    },
  ],
  roamEnabled: true,
  roam: { minDist: 80, maxDist: 260, speed: 70, pauseMinSec: 8, pauseMaxSec: 22 },
  workStatusEnabled: true,
  notifyEnabled: true,
  notifySystemToast: false,
  clickToFocusDsh: true,
  physics: { gravity: 2400, restitution: 0.55, groundFriction: 3.4, throwPower: 1 },
  workStatusTexts: [],
};

const num = (v, d) => (Number.isFinite(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/**
 * 合并配置：内置默认 ← 传入的原始对象（已被 config.jsonc / main-config.jsonc 合并过）。
 * 非法值就地回落默认，绝不因为一个坏字段让宠物消失。
 * @param {any} raw
 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pets = Array.isArray(src.pets) && src.pets.length > 0 ? src.pets : BUILTIN.pets;
  const seen = new Set();
  const outPets = [];
  for (const p of pets) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `pet${outPets.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const pos = p.position && typeof p.position === 'object' ? p.position : {};
    const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(pos.corner) ? pos.corner : 'bottom-right';
    outPets.push({
      id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
      species: typeof p.species === 'string' && p.species.trim() ? p.species.trim() : 'foxboy',
      // 素材绝对路径：正式运行时由宿主解析好传进来（助手不猜路径）
      file: typeof p.file === 'string' && p.file.trim() ? p.file.trim() : '',
      size: Math.max(48, Math.round(num(p.size, 190))),
      // 高宽比以形象清单为准（宿主已算好）；配置里写了就当兜底/覆盖
      heightRatio: num(p.heightRatio, DEFAULT_HEIGHT_RATIO) > 0 ? num(p.heightRatio, DEFAULT_HEIGHT_RATIO) : DEFAULT_HEIGHT_RATIO,
      position: { corner, marginX: num(pos.marginX, 24), marginY: num(pos.marginY, 24) },
    });
  }
  const roam = src.roam && typeof src.roam === 'object' ? src.roam : {};
  const phys = src.physics && typeof src.physics === 'object' ? src.physics : {};
  return {
    pets: outPets.length ? outPets : BUILTIN.pets,
    /** 可切换的形象清单（宿主传进来；本地开发时由 scanSpecies 扫出来） */
    species: normalizeSpecies(src.species),
    roamEnabled: bool(src.roamEnabled, BUILTIN.roamEnabled),
    roam: {
      minDist: Math.max(0, num(roam.minDist, BUILTIN.roam.minDist)),
      maxDist: Math.max(0, num(roam.maxDist, BUILTIN.roam.maxDist)),
      speed: Math.max(1, num(roam.speed, BUILTIN.roam.speed)),
      pauseMinSec: Math.max(0, num(roam.pauseMinSec, BUILTIN.roam.pauseMinSec)),
      pauseMaxSec: Math.max(0, num(roam.pauseMaxSec, BUILTIN.roam.pauseMaxSec)),
    },
    workStatusEnabled: bool(src.workStatusEnabled, BUILTIN.workStatusEnabled),
    notifyEnabled: bool(src.notifyEnabled, BUILTIN.notifyEnabled),
    notifySystemToast: bool(src.notifySystemToast, BUILTIN.notifySystemToast),
    clickToFocusDsh: bool(src.clickToFocusDsh, BUILTIN.clickToFocusDsh),
    physics: {
      gravity: Math.max(0, num(phys.gravity, BUILTIN.physics.gravity)),
      restitution: Math.min(1, Math.max(0, num(phys.restitution, BUILTIN.physics.restitution))),
      groundFriction: Math.max(0, num(phys.groundFriction, BUILTIN.physics.groundFriction)),
      throwPower: Math.max(0.05, num(phys.throwPower, BUILTIN.physics.throwPower)),
    },
    workStatusTexts: Array.isArray(src.workStatusTexts) ? src.workStatusTexts.filter((r) => Array.isArray(r)) : [],
  };
}

/**
 * 加载配置。三种来源，优先级从高到低：
 *   1. DSH_DESKPET_CONFIG_JSON —— 宿主进程直接投喂的成品配置（正常路径）
 *   2. DSH_DESKPET_CONFIG_FILE —— 开发/单机调试时用文件
 *   3. 代码内置默认
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string) => string} readFile
 */
function loadConfig(env = process.env, readFile = null) {
  if (env.DSH_DESKPET_CONFIG_JSON) {
    try {
      return normalize(JSON.parse(env.DSH_DESKPET_CONFIG_JSON));
    } catch (err) {
      console.error('[deskpet] DSH_DESKPET_CONFIG_JSON 解析失败，回落内置默认：', err && err.message);
    }
  }
  if (env.DSH_DESKPET_CONFIG_FILE && readFile) {
    try {
      return normalize(parseJsonc(readFile(env.DSH_DESKPET_CONFIG_FILE)));
    } catch (err) {
      console.error('[deskpet] 配置文件读取失败，回落内置默认：', err && err.message);
    }
  }
  return normalize({});
}

/**
 * 由宠物宽度与物种高宽比推出窗口尺寸与内部布局（全部 DIP）。
 * @param {{size: number, heightRatio: number}} pet
 */
function geometryFor(pet) {
  const size = pet.size;
  const spriteH = Math.round(size * (pet.heightRatio || DEFAULT_HEIGHT_RATIO));
  const padX = Math.round(size * PAD_RATIO.x);
  const padTop = Math.round(size * PAD_RATIO.top);
  const padBottom = Math.round(size * PAD_RATIO.bottom);
  return {
    size,
    spriteH,
    padX,
    padTop,
    padBottom,
    w: size + padX * 2,
    h: spriteH + padTop + padBottom,
    /** 精灵在窗口内的矩形（底部居中停靠） */
    sprite: { x: padX, y: padTop, w: size, h: spriteH },
    /** 可点击的「身体命中区」：比精灵矩形内缩，避免透明角落抢走桌面点击 */
    hit: {
      x: Math.round(padX + size * 0.16),
      y: Math.round(padTop + spriteH * 0.1),
      w: Math.round(size * 0.68),
      h: Math.round(spriteH * 0.86),
    },
  };
}

/**
 * 初始窗口位置：让「精灵矩形」距所选角落恰好 marginX / marginY。
 * @param {{x:number,y:number,width:number,height:number}} area
 * @param {{position:{corner:string,marginX:number,marginY:number}}} pet
 * @param {ReturnType<typeof geometryFor>} geom
 */
function initialPos(area, pet, geom) {
  const { corner, marginX, marginY } = pet.position;
  const spriteRightInWin = geom.w - geom.padX; // 精灵右边缘在窗口内的 x
  const spriteBottomInWin = geom.padTop + geom.spriteH;
  const x = corner.endsWith('right')
    ? area.x + area.width - marginX - spriteRightInWin
    : area.x + marginX - geom.padX;
  const y = corner.startsWith('bottom')
    ? area.y + area.height - marginY - spriteBottomInWin
    : area.y + marginY - geom.padTop;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 把窗口位置夹回工作区：约束的是「精灵矩形」不越界（留白允许溢出屏幕）。
 * @param {{x:number,y:number,width:number,height:number}} area
 * @param {ReturnType<typeof geometryFor>} geom
 */
function clampWindowPos(area, geom, x, y) {
  const minX = area.x - geom.padX;
  const maxX = area.x + area.width - geom.w + geom.padX;
  const minY = area.y - geom.padTop;
  const maxY = area.y + area.height - geom.h + geom.padTop;
  return {
    x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY))),
  };
}

/**
 * 规范化物种清单（assets/pet/species.json）。
 * 清单由 scripts/prepare-pets.py 生成，是「有哪些形象可切」的唯一事实来源。
 * @param {any} raw
 */
function normalizeSpecies(raw) {
  const list = raw && Array.isArray(raw.species) ? raw.species : [];
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const width = num(s.width, 0);
    const height = num(s.height, 0);
    const ratio = num(s.heightRatio, 0) > 0 ? num(s.heightRatio, 0) : height > 0 && width > 0 ? height / width : DEFAULT_HEIGHT_RATIO;
    seen.add(id);
    out.push({
      id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : id,
      file: typeof s.file === 'string' && s.file.trim() ? s.file.trim() : `${id}/idle.png`,
      width,
      height,
      heightRatio: ratio,
    });
  }
  return out;
}

/**
 * 把宠物实例上的 species 解析成清单里的物种；清单里没有就退回内置兜底，
 * 保证「配了个不存在的形象」也不会让宠物消失（只会退回默认形象）。
 * @param {{species: string, heightRatio: number, size: number}} pet
 * @param {ReturnType<typeof normalizeSpecies>} speciesList
 */
function resolveSpecies(pet, speciesList) {
  const found = speciesList.find((s) => s.id === pet.species);
  if (found) return found;
  return {
    id: pet.species,
    name: pet.species,
    file: `${pet.species}/idle.png`,
    width: 0,
    height: 0,
    heightRatio: pet.heightRatio || DEFAULT_HEIGHT_RATIO,
  };
}

/**
 * 扫描形象根目录（**本地开发兜底**）：`<dir>/<id>/idle.png`，可选 `<dir>/<id>/species.json`
 * 提供显示名。正式运行时形象清单由宿主解析好经 config 传进来，这条路径只在
 * 「不经过 DSH、直接用 scripts/start-helper.mjs 跑助手」时用到。
 * @param {string} dir
 * @returns {ReturnType<typeof normalizeSpecies>}
 */
function scanSpeciesDir(dir) {
  const out = [];
  let ids;
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const id of ids) {
    const sub = path.join(dir, id);
    const img = path.join(sub, 'idle.png');
    try {
      if (!fs.statSync(sub).isDirectory() || !fs.existsSync(img)) continue;
    } catch {
      continue;
    }
    let name = id;
    let width = 0;
    let height = 0;
    const metaFile = path.join(sub, 'species.json');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim();
        width = Number(meta.width) || 0;
        height = Number(meta.height) || 0;
      } catch {
        /* 元数据坏了不影响出图 */
      }
    }
    if (!width || !height) {
      // 直接读 PNG 的 IHDR
      try {
        const buf = fs.readFileSync(img);
        if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
          width = buf.readUInt32BE(16);
          height = buf.readUInt32BE(20);
        }
      } catch {
        /* 忽略 */
      }
    }
    out.push({ id, name, file: img, width, height, heightRatio: height > 0 && width > 0 ? height / width : DEFAULT_HEIGHT_RATIO });
  }
  return normalizeSpecies({ species: out });
}

module.exports = {
  DEFAULT_HEIGHT_RATIO,
  PAD_RATIO,
  BUILTIN,
  stripJsonc,
  parseJsonc,
  normalize,
  normalizeSpecies,
  resolveSpecies,
  scanSpeciesDir,
  loadConfig,
  geometryFor,
  initialPos,
  clampWindowPos,
};
