import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
//#region src/host/config.ts
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
/** 剥掉 JSONC 的注释（字符串内的 // 与 /* 不动） */
function stripJsonc(text) {
	const src = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
	let out = "";
	let inStr = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		const n = src[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			out += c;
			if (c === "\\") out += src[++i] ?? "";
			else if (c === "\"") inStr = false;
			continue;
		}
		if (c === "\"") {
			inStr = true;
			out += c;
			continue;
		}
		if (c === "/" && n === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}
function parseJsonc(text) {
	return JSON.parse(stripJsonc(text));
}
const BUILTIN = {
	pets: [{
		id: "main",
		name: "阿狐",
		species: "foxboy",
		size: 190,
		position: {
			corner: "bottom-right",
			marginX: 24,
			marginY: 24
		}
	}],
	roamEnabled: true,
	roam: {
		minDist: 80,
		maxDist: 260,
		speed: 70,
		pauseMinSec: 8,
		pauseMaxSec: 22
	},
	workStatusEnabled: true,
	notifyEnabled: true,
	notifySystemToast: true,
	clickToFocusDsh: true,
	physics: {
		gravity: 2400,
		restitution: .55,
		groundFriction: 3.4,
		throwPower: 1
	},
	workStatusTexts: [
		["正在想呢…"],
		["正在干活，别打扰我～"],
		["搞定一步，继续～"],
		["轮到你来决定啦，等你～"],
		["这一轮搞定啦！"],
		["好像卡住了呢…"]
	]
};
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const num = (v, d) => typeof v === "number" && Number.isFinite(v) ? v : d;
const bool = (v, d) => typeof v === "boolean" ? v : d;
const str = (v, d) => typeof v === "string" && v.trim() ? v.trim() : d;
/**
* 把任意来源的对象归一化成合法配置。
* @param raw 原始对象（包内默认与用户层已合并过，或其中任一）
*/
function normalizeConfig(raw) {
	const warnings = [];
	const src = raw && typeof raw === "object" ? raw : {};
	const rawPets = Array.isArray(src.pets) ? src.pets : [];
	const pets = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [i, p] of rawPets.entries()) {
		if (!p || typeof p !== "object") {
			warnings.push(`pets[${i}] 不是对象，已跳过`);
			continue;
		}
		const o = p;
		const id = str(o.id, "");
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
		const pos = o.position && typeof o.position === "object" ? o.position : {};
		const corner = CORNERS.includes(pos.corner) ? pos.corner : "bottom-right";
		if (pos.corner !== void 0 && !CORNERS.includes(pos.corner)) warnings.push(`pets[${i}].position.corner="${String(pos.corner)}" 非法，回落 bottom-right`);
		pets.push({
			id,
			name: str(o.name, id),
			species: str(o.species, "foxboy"),
			size: Math.max(64, Math.round(num(o.size, 190))),
			position: {
				corner,
				marginX: num(pos.marginX, 24),
				marginY: num(pos.marginY, 24)
			}
		});
	}
	if (!pets.length) {
		if (rawPets.length) warnings.push("pets 里没有一条合法配置，已回落内置默认宠物");
		pets.push(...BUILTIN.pets.map((p) => ({
			...p,
			position: { ...p.position }
		})));
	}
	const roamRaw = src.roam && typeof src.roam === "object" ? src.roam : {};
	const physRaw = src.physics && typeof src.physics === "object" ? src.physics : {};
	const texts = Array.isArray(src.workStatusTexts) ? src.workStatusTexts.filter(Array.isArray).map((row) => row.filter((s) => typeof s === "string" && s.trim() !== "")) : BUILTIN.workStatusTexts;
	return {
		config: {
			pets,
			roamEnabled: bool(src.roamEnabled, BUILTIN.roamEnabled),
			roam: {
				minDist: Math.max(0, num(roamRaw.minDist, BUILTIN.roam.minDist)),
				maxDist: Math.max(0, num(roamRaw.maxDist, BUILTIN.roam.maxDist)),
				speed: Math.max(1, num(roamRaw.speed, BUILTIN.roam.speed)),
				pauseMinSec: Math.max(0, num(roamRaw.pauseMinSec, BUILTIN.roam.pauseMinSec)),
				pauseMaxSec: Math.max(0, num(roamRaw.pauseMaxSec, BUILTIN.roam.pauseMaxSec))
			},
			workStatusEnabled: bool(src.workStatusEnabled, BUILTIN.workStatusEnabled),
			notifyEnabled: bool(src.notifyEnabled, BUILTIN.notifyEnabled),
			notifySystemToast: bool(src.notifySystemToast, BUILTIN.notifySystemToast),
			clickToFocusDsh: bool(src.clickToFocusDsh, BUILTIN.clickToFocusDsh),
			physics: {
				gravity: Math.max(0, num(physRaw.gravity, BUILTIN.physics.gravity)),
				restitution: Math.min(1, Math.max(0, num(physRaw.restitution, BUILTIN.physics.restitution))),
				groundFriction: Math.max(0, num(physRaw.groundFriction, BUILTIN.physics.groundFriction)),
				throwPower: Math.max(.05, num(physRaw.throwPower, BUILTIN.physics.throwPower))
			},
			workStatusTexts: texts.length ? texts : BUILTIN.workStatusTexts
		},
		warnings
	};
}
/** 浅合并：用户层只覆盖它写了的顶层字段（pets 数组整体覆盖） */
function mergeLayers(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) {
		if (v === void 0) continue;
		if (k === "roam" || k === "physics") {
			out[k] = {
				...base[k] && typeof base[k] === "object" ? base[k] : {},
				...v && typeof v === "object" ? v : {}
			};
			continue;
		}
		out[k] = v;
	}
	return out;
}
const USER_CONFIG_NAME = "main-config.jsonc";
function userConfigPath(userRoot) {
	return join(userRoot, USER_CONFIG_NAME);
}
function readJsoncFile(file) {
	if (!existsSync(file)) return null;
	try {
		return parseJsonc(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file} 解析失败：${err.message}`);
	}
}
/**
* 载入并合并配置。用户层损坏时**不静默**：把错误抛给调用方去告警，
* 同时回落到包内默认继续跑（宠物不该因为配置写坏了就消失）。
*/
function loadConfig(paths) {
	let base = {};
	try {
		base = readJsoncFile(join(paths.assetsDir, "config.jsonc")) ?? {};
	} catch (err) {
		return {
			...normalizeConfig({}),
			hasUserConfig: existsSync(userConfigPath(paths.userRoot)),
			warnings: [err.message]
		};
	}
	const userFile = userConfigPath(paths.userRoot);
	let over = null;
	const warnings = [];
	try {
		over = readJsoncFile(userFile);
	} catch (err) {
		warnings.push(`${err.message}（已忽略用户层，使用包内默认）`);
	}
	const normalized = normalizeConfig(over ? mergeLayers(base, over) : base);
	return {
		...normalized,
		warnings: [...warnings, ...normalized.warnings],
		hasUserConfig: over !== null
	};
}
/** 把配置写入用户层（唯一会被运行时改写的那份） */
function saveConfig(userRoot, config) {
	mkdirSync(userRoot, { recursive: true });
	writeFileSync(userConfigPath(userRoot), "// dsh-deskpet 用户配置（由设置页 / 右键菜单写入，可直接手改）\n// 完整字段说明见插件包内 assets/config.jsonc；这里没写的字段取内置默认。\n" + JSON.stringify(config, null, 2) + "\n", "utf8");
}
/** 读 PNG 的 IHDR 拿宽高（不用任何图像库） */
function pngSize(buf) {
	if (buf.length < 24) return null;
	if (buf.readUInt32BE(0) !== 2303741511 || buf.readUInt32BE(4) !== 218765834) return null;
	return {
		width: buf.readUInt32BE(16),
		height: buf.readUInt32BE(20)
	};
}
/**
* 扫描一个「形象根目录」下的所有物种：`<root>/<id>/idle.png`，可选
* `<root>/<id>/species.json` 提供显示名。零配置即可加新形象（拖个文件夹进去就行）。
*/
function scanSpeciesRoot(root, origin, out) {
	if (!existsSync(root)) return;
	let entries;
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
		const img = join(dir, "idle.png");
		if (!existsSync(img)) continue;
		let width = 0;
		let height = 0;
		try {
			const size = pngSize(readFileSync(img));
			if (size) {
				width = size.width;
				height = size.height;
			}
		} catch {}
		let name = id;
		const meta = join(dir, "species.json");
		if (existsSync(meta)) try {
			const o = parseJsonc(readFileSync(meta, "utf8"));
			name = str(o.name, id);
			width = Math.round(num(o.width, width));
			height = Math.round(num(o.height, height));
		} catch {}
		const heightRatio = height > 0 && width > 0 ? Number((height / width).toFixed(4)) : 1.8;
		out.set(id, {
			id,
			name,
			file: img,
			width,
			height,
			heightRatio,
			origin
		});
	}
}
/**
* 汇总可用形象：**包内先扫、用户目录后扫**，用户同名形象覆盖包内（方便用户改图不改 id）。
*/
function discoverSpecies(paths) {
	const map = /* @__PURE__ */ new Map();
	scanSpeciesRoot(join(paths.assetsDir, "pet"), "package", map);
	scanSpeciesRoot(join(paths.userRoot, "pet"), "user", map);
	return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
/**
* 把配置里引用的、清单里不存在的形象修正到第一个可用形象（避免"配错一个 id 宠物就没了"）。
*/
function reconcileSpecies(config, species) {
	const warnings = [];
	if (!species.length) return {
		config,
		warnings: ["没有发现任何形象素材（assets/pet/<id>/idle.png）"]
	};
	const fallback = species[0];
	const pets = config.pets.map((p) => {
		if (species.some((s) => s.id === p.species)) return p;
		warnings.push(`宠物 "${p.id}" 的形象 "${p.species}" 不存在，回落 "${fallback.id}"`);
		return {
			...p,
			species: fallback.id
		};
	});
	return {
		config: {
			...config,
			pets
		},
		warnings
	};
}
//#endregion
//#region src/host/helper-process.ts
/**
* 桌面助手进程的管理：找 Electron、拉起、守护、双向通信
* ============================================================================
* 两个方向各有一条可靠通道（这是本项目最关键的平台结论，别改回去）：
*   助手 → 宿主：stdout 一行一个 JSON（日志行不带 JSON 前缀，按能否 parse 区分）
*   宿主 → 助手：助手起一个 127.0.0.1 随机端口 HTTP 服务器，经 stdout 的 ready
*                事件把地址报上来，宿主 POST /cmd 下发命令。
*   为什么不能用 stdin：Electron 主进程在 Windows 收不到 piped stdin（electron#4218），
*   实测一启动就 EOF（对照实验：同样重定向下纯 Node 进程能正常读到）。
*
* 另一条必须遵守的规矩：spawn 时**删掉 ELECTRON_RUN_AS_NODE**。
* 宿主自己是 Electron-as-Node 起的，该变量会继承给子进程，导致 Electron 以纯 Node
* 模式启动、require('electron') 直接 MODULE_NOT_FOUND。
*/
/** 与本机已验证可用的版本保持一致（dsh-pet 下载的那份就是它） */
const DEFAULT_ELECTRON_VERSION = "43.3.0";
const DOWNLOAD_TIMEOUT_MS = 9e5;
/** 找回 Electron：环境变量 → 本机落地目录（dsh-pet 也会下到这里）→ 官网镜像下载 */
function electronLandingDir() {
	return join(homedir(), ".dsh", "electron");
}
function findElectron(log) {
	const exeName = process.platform === "win32" ? "electron.exe" : "electron";
	const explicit = process.env.DSH_DESKPET_ELECTRON_PATH;
	if (explicit && existsSync(explicit)) return explicit;
	if (explicit) log(`DSH_DESKPET_ELECTRON_PATH 指向的文件不存在：${explicit}`);
	const landed = join(electronLandingDir(), exeName);
	if (existsSync(landed)) return landed;
	return null;
}
/**
* 命令通道客户端 + 进程守护。
*/
var HelperProcess = class {
	options;
	child = null;
	callbackUrl = null;
	stdoutBuf = "";
	stopping = false;
	failures = 0;
	restartTimer = null;
	stableTimer = null;
	/** 助手上报的能力（物种列表等），供设置页展示 */
	lastReady = null;
	constructor(options) {
		this.options = options;
	}
	get ready() {
		return this.callbackUrl !== null;
	}
	get readyInfo() {
		return this.lastReady;
	}
	/** 启动；Electron 缺失时返回 false（不抛错，插件其余部分照常工作） */
	start() {
		if (this.stopping) return false;
		const electron = findElectron(this.options.log);
		if (!electron) {
			this.options.log(`找不到 Electron 运行时，桌面宠物已停用。把 Electron 解压到 ${electronLandingDir()}（或设 DSH_DESKPET_ELECTRON_PATH），或设置 DSH_DESKPET_ALLOW_DOWNLOAD=1 让本插件自动下载。`);
			if (process.env.DSH_DESKPET_ALLOW_DOWNLOAD === "1") this.downloadElectron();
			return false;
		}
		this.spawn(electron);
		return true;
	}
	/** 改配置后重启（等旧进程真的退出再起新的，否则会出现两只宠物） */
	restart(config) {
		this.options.config = config;
		if (this.child) {
			this.options.log("配置已变，重启桌面助手…");
			this.stopping = true;
			const child = this.child;
			child.once("exit", () => {
				this.stopping = false;
				this.callbackUrl = null;
				this.failures = 0;
				this.start();
			});
			child.kill();
			return;
		}
		this.callbackUrl = null;
		this.failures = 0;
		this.start();
	}
	/**
	* 插件卸载时调用。
	* **刻意不杀宠物进程**：需求是「DSH 退出后点桌宠能把应用打开」，所以宠物要活到 DSH 之外。
	* 这里只发一条 hostGone 让它转入孤儿模式（待机/漫游照旧，点击动作变成"启动 DSH"）。
	* 下一次 DSH 启动时，新宠物会读 helper.json 把旧的请出去，不会出现两只。
	* 想立刻收掉它：右键宠物 → 退出桌宠。
	*/
	stop() {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		if (this.stableTimer) clearTimeout(this.stableTimer);
		this.restartTimer = null;
		this.stableTimer = null;
		const url = this.callbackUrl;
		this.child = null;
		this.callbackUrl = null;
		if (!url) return;
		fetch(`${url}/cmd`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cmd: "hostGone" }),
			signal: AbortSignal.timeout(1500)
		}).then(() => this.options.log("已通知宠物进入孤儿模式（DSH 退出后仍可点它启动应用）")).catch(() => {});
	}
	/**
	* 下发一条命令。通道未就绪时返回 false（调用方自行决定是否忽略）。
	*/
	async send(cmd) {
		const url = this.callbackUrl;
		if (!url) return false;
		try {
			const res = await fetch(`${url}/cmd`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(cmd),
				signal: AbortSignal.timeout(3e3)
			});
			if (!res.ok) this.options.log(`命令下发失败：HTTP ${res.status}（${JSON.stringify(cmd).slice(0, 120)}）`);
			return res.ok;
		} catch (err) {
			this.options.log(`命令下发异常：${err.message}`);
			return false;
		}
	}
	spawn(electron) {
		const env = {
			...process.env,
			DSH_DESKPET_CONFIG_JSON: JSON.stringify(this.options.config),
			DSH_DESKPET_DSH_PID: String(this.options.dshPid || 0),
			DSH_DESKPET_DSH_EXE: this.options.dshExe,
			DSH_DESKPET_HOST_PID: String(process.pid),
			DSH_DESKPET_USER_ROOT: this.options.userRoot,
			DSH_DESKPET_LOG: this.options.logFile
		};
		delete env.ELECTRON_RUN_AS_NODE;
		this.options.log(`拉起桌面助手：${electron} ${this.options.helperEntry}`);
		const child = spawn(electron, [this.options.helperEntry], {
			cwd: join(this.options.packageRoot, "runtime", "electron-helper"),
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			detached: true
		});
		child.unref();
		this.child = child;
		this.stdoutBuf = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => this.consumeStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) this.options.log(`[helper:err] ${text}`);
		});
		child.on("error", (err) => this.options.log(`桌面助手进程错误：${err.message}`));
		child.on("exit", (code, signal) => {
			this.child = null;
			this.callbackUrl = null;
			if (this.stableTimer) {
				clearTimeout(this.stableTimer);
				this.stableTimer = null;
			}
			if (this.stopping) {
				this.options.log("桌面助手已退出（插件停止中）");
				return;
			}
			this.options.log(`桌面助手退出：code=${code ?? "null"} signal=${signal ?? "null"}`);
			this.scheduleRestart();
		});
	}
	/** stdout 按行切：能 parse 成带 type 的 JSON = 事件，其余 = 日志 */
	consumeStdout(chunk) {
		this.stdoutBuf += chunk;
		let nl;
		while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line) continue;
			let parsed = null;
			if (line.startsWith("{")) try {
				parsed = JSON.parse(line);
			} catch {
				parsed = null;
			}
			if (parsed && typeof parsed === "object" && typeof parsed.type === "string") this.handleEvent(parsed);
			else this.options.log(`[helper] ${line}`);
		}
	}
	handleEvent(event) {
		if (event.type === "ready") {
			this.callbackUrl = typeof event.callback === "string" ? event.callback : null;
			this.lastReady = event;
			this.failures = 0;
			this.options.log(`桌面助手就绪：命令通道 ${this.callbackUrl ?? "(无)"}，形象 ${JSON.stringify(event.species ?? [])}`);
			this.stableTimer = setTimeout(() => {
				this.failures = 0;
			}, 18e4);
			if (typeof this.stableTimer.unref === "function") this.stableTimer.unref();
		}
		this.options.onEvent?.(event);
	}
	scheduleRestart() {
		const max = this.options.maxFailures ?? 8;
		this.failures += 1;
		if (this.failures > max) {
			this.options.log(`桌面助手连续失败 ${this.failures} 次，已停止重试（改配置或重启 DSH 后再试）`);
			return;
		}
		const delay = Math.min(3e4, 750 * 2 ** (this.failures - 1));
		this.options.log(`${delay}ms 后重启桌面助手（第 ${this.failures} 次）`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.start();
		}, delay);
		if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
	}
	/**
	* 自动下载 Electron（未在本机验证过的路径：本机已有运行时，走不到这里）。
	* 用 Node 自带 fetch 抓镜像 zip，再交给 PowerShell 的 Expand-Archive 解压，零第三方依赖。
	*/
	async downloadElectron() {
		const version = process.env.DSH_DESKPET_ELECTRON_VERSION || DEFAULT_ELECTRON_VERSION;
		const mirror = process.env.DSH_DESKPET_ELECTRON_MIRROR || "https://registry.npmmirror.com/-/binary/electron";
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		const file = `electron-v${version}-${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${arch}.zip`;
		const url = `${mirror}/${version}/${file}`;
		const target = electronLandingDir();
		this.options.log(`开始下载 Electron ${version}：${url}`);
		try {
			const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const zipPath = join(mkdtempSync(join(tmpdir(), "deskpet-electron-")), file);
			const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			const { writeFileSync } = await import("node:fs");
			writeFileSync(zipPath, buf);
			mkdirSync(target, { recursive: true });
			const ps = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`;
			const code = await new Promise((resolve) => {
				const p = spawn("powershell.exe", [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					ps
				], {
					stdio: "ignore",
					windowsHide: true
				});
				p.on("exit", (c) => resolve(c ?? 1));
				p.on("error", () => resolve(1));
			});
			rmSync(zipPath, { force: true });
			if (code !== 0) throw new Error(`解压失败（Expand-Archive 退出码 ${code}）`);
			this.options.log(`Electron 已就绪：${target}`);
			this.start();
		} catch (err) {
			this.options.log(`Electron 下载失败：${err.message}。可手动放置到 ${target}`);
		}
	}
};
//#endregion
//#region src/host/notify.ts
/** 详情文案上限，别让气泡炸开 */
const DETAIL_MAX = 80;
function clip(s, max = DETAIL_MAX) {
	const t = s.replace(/\s+/g, " ").trim();
	const points = Array.from(t);
	return points.length > max ? `${points.slice(0, max).join("")}…` : t;
}
const USER_QUESTION_TOOL$1 = "ask_user_question";
/**
* 一条 session/event → 提醒；不关心的事件返回 null。
*/
function noticeFromEvent(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = String(reason?.kind ?? "");
			if (kind === "completed") return {
				kind: "done",
				text: "这一轮搞定啦！",
				level: "success",
				toast: true
			};
			if (kind === "error") {
				const msg = String(reason?.error?.message ?? "");
				return {
					kind: "error",
					text: "刚才这一步出错了…",
					detail: msg ? clip(msg) : void 0,
					level: "error",
					toast: true
				};
			}
			if (kind === "max-tokens") return {
				kind: "truncated",
				text: "输出太长被截断了",
				level: "attention",
				toast: true
			};
			return null;
		}
		case "approval/asked": {
			const tool = String(event.data?.toolName ?? "");
			const reason = String(event.data?.reason ?? "");
			return {
				kind: "approval",
				text: "需要你确认一下～",
				detail: clip(tool || reason) || void 0,
				level: "attention",
				toast: true
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL$1) return null;
			const q = firstQuestion(event.data?.arguments);
			return {
				kind: "question",
				text: "有个问题等你回答",
				detail: q ? clip(q) : void 0,
				level: "attention",
				toast: true
			};
		}
		default: return null;
	}
}
/** ask_user_question 的 arguments（JSON 字符串）→ 第一个问题原文 */
function firstQuestion(args) {
	if (typeof args !== "string") return null;
	try {
		const list = JSON.parse(args)?.questions;
		if (!Array.isArray(list) || !list.length) return null;
		return String(list[0]?.question ?? "").trim() || null;
	} catch {
		return null;
	}
}
/** `agent/error`（没有回合位置的失败）→ 提醒 */
function noticeFromAgentError(error) {
	const msg = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		kind: "error",
		text: "出错了，看一下？",
		detail: msg ? clip(msg) : void 0,
		level: "error",
		toast: true
	};
}
//#endregion
//#region src/host/work-status.ts
const WORK_LEVELS = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
/** 档位索引（= workStatusTexts 的下标） */
function levelIndex(level) {
	const i = WORK_LEVELS.indexOf(level);
	return i < 0 ? 0 : i;
}
/**
* 展示优先级：等用户确认 > 出错 > 干活 > 思考 > 单步完成 > 全部完成。
* result 高于 success，是为了避免"某个会话刚完成"压掉"另一个会话正在进行的过渡态"。
*/
const PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
/** turn/end 的 reason.kind → 落哪一档；null = 该回合已结束但无需展示 */
function levelForTurnEnd(kind, turn, goalAware) {
	if (kind === "completed") {
		if (!goalAware || !turn?.goalRound) return "success";
		if (turn.closing === "blocked") return "error";
		if (turn.closing === "complete") return "success";
		return "result";
	}
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** update_goal 的 arguments（JSON 字符串）→ 收尾动作；非收尾返回 null */
function goalClosingAction(args) {
	if (typeof args !== "string") return null;
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
/** todo 清单 → 当前该展示的任务文案（取最后一个 in_progress，否则第一个 pending） */
function taskFromTodos(todos) {
	const list = Array.isArray(todos) ? todos : [];
	let current;
	for (const t of list) if (t?.status === "in_progress") current = t;
	if (!current) current = list.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > 40 ? `${points.slice(0, 40).join("")}…` : content;
}
/** 等用户答复的工具：触发它 = 在等你，不是普通干活 */
const USER_QUESTION_TOOL = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
/**
* 工作状态聚合器。
* 用法：`apply(sessionId, event)`；有变化时会触发 onChange（index.ts 据此推给宠物）。
*/
var WorkStatusTracker = class {
	sessions = /* @__PURE__ */ new Map();
	turns = /* @__PURE__ */ new Map();
	timers = /* @__PURE__ */ new Map();
	snapshot = {
		level: null,
		task: null,
		ts: 0
	};
	goalAware;
	ttl;
	onChange;
	seqCounter = 0;
	constructor(options = {}) {
		this.goalAware = options.goalAware !== false;
		this.ttl = options.terminalTtlMs ?? 6e4;
		this.onChange = options.onChange;
	}
	setOnChange(cb) {
		this.onChange = cb;
	}
	current() {
		return this.snapshot;
	}
	/**
	* 喂一条会话事件。
	* @returns 展示快照是否发生变化
	*/
	apply(sessionId, event) {
		const type = event?.type;
		if (!type) return false;
		const seq = Number.isFinite(event.seq) ? Number(event.seq) : ++this.seqCounter;
		if (type === "todo/write") {
			if (!this.sessions.has(sessionId)) return false;
			return this.setTask(sessionId, taskFromTodos(event.data?.todos));
		}
		if (type === "user/message") {
			if (this.goalAware && event.data?.source?.kind === "goal") this.flags(sessionId).goalRound = true;
			return false;
		}
		if (type === "turn/start") {
			this.turns.set(sessionId, {
				goalRound: false,
				closing: null
			});
			this.setTask(sessionId, null);
		}
		if (type === "tool/call" && String(event.data?.name ?? "") === GOAL_UPDATE_TOOL) {
			const action = goalClosingAction(event.data?.arguments);
			if (action) this.flags(sessionId).closing = action;
		}
		let level;
		switch (type) {
			case "turn/start":
				level = "thinking";
				break;
			case "tool/call":
				level = String(event.data?.name ?? "") === USER_QUESTION_TOOL ? "waiting" : "working";
				break;
			case "tool/result":
				level = "result";
				break;
			case "approval/asked":
				level = "waiting";
				break;
			case "turn/end":
				level = levelForTurnEnd(String(event.data?.reason?.kind ?? ""), this.turns.get(sessionId), this.goalAware);
				break;
			default: return false;
		}
		if (level === null) {
			this.turns.delete(sessionId);
			this.cancelTimer(sessionId);
			return this.clear(sessionId);
		}
		return this.setLevel(sessionId, level, seq);
	}
	/** 插件卸载时清掉所有定时器 */
	dispose() {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.sessions.clear();
		this.turns.clear();
	}
	flags(sessionId) {
		let f = this.turns.get(sessionId);
		if (!f) {
			f = {
				goalRound: false,
				closing: null
			};
			this.turns.set(sessionId, f);
		}
		return f;
	}
	setLevel(sessionId, level, seq) {
		const prev = this.sessions.get(sessionId);
		if (prev && prev.level === level && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			level,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		if (level === "success" || level === "error") this.scheduleTerminalCleanup(sessionId);
		else this.cancelTimer(sessionId);
		return true;
	}
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	scheduleTerminalCleanup(sessionId) {
		this.cancelTimer(sessionId);
		const timer = setTimeout(() => {
			this.timers.delete(sessionId);
			const entry = this.sessions.get(sessionId);
			if (entry && (entry.level === "success" || entry.level === "error")) this.clear(sessionId);
		}, this.ttl);
		if (typeof timer.unref === "function") timer.unref();
		this.timers.set(sessionId, timer);
	}
	cancelTimer(sessionId) {
		const t = this.timers.get(sessionId);
		if (t) {
			clearTimeout(t);
			this.timers.delete(sessionId);
		}
	}
	/** 重算展示快照：优先级最高者胜出，同级取更近的 seq */
	refresh() {
		let best = null;
		for (const [id, entry] of this.sessions) if (!best || PRIORITY[entry.level] > PRIORITY[best.level] || PRIORITY[entry.level] === PRIORITY[best.level] && entry.seq > best.seq) best = entry;
		const nextLevel = best?.level ?? null;
		const nextTask = best?.task ?? null;
		if (nextLevel === this.snapshot.level && nextTask === this.snapshot.task) return;
		this.snapshot.level = nextLevel;
		this.snapshot.task = nextTask;
		this.snapshot.ts = Date.now();
		this.onChange?.(this.snapshot);
	}
};
//#endregion
//#region src/host/index.ts
/**
* dsh-deskpet 宿主半侧（DSH 插件入口）
* ============================================================================
* 职责：
*   1. 配置与形象清单的加载 / 归一化 / 落盘
*   2. 拉起并守护桌面助手进程（独立 Electron），提供双向通道
*   3. 监听 DSH 会话事件 → 工作状态（连续态）与提醒（离散事件）→ 推给宠物
*   4. 给设置页提供 HTTP 接口
*
* 本文件不碰任何渲染：宠物长什么样、怎么动全在 runtime/electron-helper 里。
* 依赖只有 Node 内置模块 + ctx 注入的 webServer。
*/
const name = "deskpet";
/** 只依赖 DSH 的 HTTP 服务；其余（llm/credentials/commands）本插件一律不用，零模型成本 */
const inject = ["webServer"];
const ROUTE_PREFIX = "/dsh-deskpet";
const BODY_MAX = 1 << 20;
/** 包根目录：lib/index.js → 上两级 */
function pluginRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}
/** 会话 id：DSH 给的 session 对象有两种形状，都兜住 */
function sessionIdOf(session) {
	const s = session;
	return String(s?.header?.id ?? s?.id ?? "unknown");
}
/** 配置 → 助手要的载荷：把形象解析成绝对素材路径，助手不再猜路径 */
function helperConfig(config, species) {
	const fallback = species[0];
	return {
		pets: config.pets.map((p) => {
			const sp = species.find((s) => s.id === p.species) ?? fallback;
			return {
				id: p.id,
				name: p.name,
				species: sp?.id ?? p.species,
				speciesName: sp?.name ?? p.species,
				file: sp?.file ?? "",
				size: p.size,
				heightRatio: sp?.heightRatio ?? 1.8,
				position: { ...p.position }
			};
		}),
		species: species.map((s) => ({
			id: s.id,
			name: s.name,
			file: s.file,
			heightRatio: s.heightRatio,
			width: s.width,
			height: s.height
		})),
		roamEnabled: config.roamEnabled,
		roam: config.roam,
		physics: config.physics,
		workStatusEnabled: config.workStatusEnabled,
		notifyEnabled: config.notifyEnabled,
		notifySystemToast: config.notifySystemToast,
		clickToFocusDsh: config.clickToFocusDsh,
		workStatusTexts: config.workStatusTexts
	};
}
function apply(ctx) {
	const root = pluginRoot();
	const assetsDir = join(root, "assets");
	const userRoot = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-deskpet");
	const logFile = join(userRoot, "helper.log");
	const paths = {
		assetsDir,
		userRoot
	};
	try {
		mkdirSync(userRoot, { recursive: true });
	} catch (err) {
		console.warn(`[deskpet] 无法创建用户数据目录 ${userRoot}：${err.message}`);
	}
	const log = (msg) => {
		if (ctx.logger?.info) ctx.logger.info(`[deskpet] ${msg}`);
		else console.log(`[deskpet] ${msg}`);
	};
	const warn = (msg) => {
		if (ctx.logger?.warn) ctx.logger.warn(`[deskpet] ${msg}`);
		else console.warn(`[deskpet] ${msg}`);
	};
	let species = discoverSpecies(paths);
	const loaded = loadConfig(paths);
	let config = reconcileSpecies(loaded.config, species).config;
	for (const w of loaded.warnings) warn(w);
	if (!species.length) warn(`没有发现任何形象素材：${join(assetsDir, "pet")}/<id>/idle.png`);
	log(`配置载入完成：${config.pets.length} 只宠物，${species.length} 个形象，用户层${loaded.hasUserConfig ? "存在" : "不存在"}`);
	/** DSH 窗口是否在前台（由客户端半侧上报；未知时按「在前台」处理，避免误弹系统通知） */
	let dshFocused = true;
	const tracker = new WorkStatusTracker({ onChange: (snap) => void pushWorkStatus(snap) });
	const helper = new HelperProcess({
		packageRoot: root,
		helperEntry: join(root, "runtime", "electron-helper", "main.js"),
		logFile,
		config: helperConfig(config, species),
		dshPid: process.ppid,
		dshExe: process.execPath,
		userRoot,
		log,
		onEvent: (event) => handleHelperEvent(event)
	});
	async function handleHelperEvent(event) {
		if (event.type === "species-changed") {
			const petId = String(event.pet ?? "");
			const next = String(event.species ?? "");
			const pet = config.pets.find((p) => p.id === petId);
			if (!pet || pet.species === next || !species.some((s) => s.id === next)) return;
			config = {
				...config,
				pets: config.pets.map((p) => p.id === petId ? {
					...p,
					species: next
				} : p)
			};
			try {
				saveConfig(userRoot, config);
				log(`形象已写回用户配置：${petId} → ${next}`);
			} catch (err) {
				warn(`写回形象失败：${err.message}`);
			}
			return;
		}
		if (event.type === "request-reload") {
			log("宠物请求重载配置：重新读取磁盘配置…");
			try {
				species = discoverSpecies(paths);
				const reloaded = loadConfig(paths);
				const reconciled = reconcileSpecies(reloaded.config, species);
				config = reconciled.config;
				for (const w of [...reloaded.warnings, ...reconciled.warnings]) warn(w);
				helper.restart(helperConfig(config, species));
			} catch (err) {
				warn(`重载配置失败：${err.message}`);
			}
		}
	}
	async function pushWorkStatus(snap) {
		if (!config.workStatusEnabled) return;
		const level = snap.level;
		const index = level ? levelIndex(level) : -1;
		await helper.send({
			cmd: "workStatus",
			level,
			index,
			text: level ? pickWorkText(level, index, snap.task) : null,
			task: snap.task
		});
	}
	/**
	* 档位文案：干活类（思考/干活/整理）优先用 todo 清单里的具体任务，
	* 其余档位从配置的备选句里随机抽一句（每档多句，避免重复看同一句）。
	*/
	function pickWorkText(level, index, task) {
		if (task && (level === "thinking" || level === "working" || level === "result")) return task;
		const row = config.workStatusTexts[index];
		if (!row || !row.length) return null;
		return row[Math.floor(Math.random() * row.length)] ?? null;
	}
	async function pushNotice(notice) {
		if (!config.notifyEnabled) return;
		await helper.send({
			cmd: "notice",
			kind: notice.kind,
			text: notice.text,
			detail: notice.detail ?? null,
			level: notice.level,
			toast: notice.toast && config.notifySystemToast && !dshFocused,
			dshFocused
		});
	}
	ctx.effect(() => {
		helper.start();
		return () => helper.stop();
	}, "dsh-deskpet: 桌面助手进程");
	ctx.effect(() => {
		const offSession = ctx.on("session/event", (...args) => {
			const session = args[0];
			const event = args[1];
			if (!event?.type) return;
			const id = sessionIdOf(session);
			tracker.apply(id, event);
			const notice = noticeFromEvent(event);
			if (notice) pushNotice(notice);
		});
		const offError = ctx.on("agent/error", (...args) => {
			pushNotice(noticeFromAgentError(args[0]));
		});
		return () => {
			offSession();
			offError();
			tracker.dispose();
		};
	}, "dsh-deskpet: 会话事件 → 宠物");
	const readBody = (req) => new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > BODY_MAX) reject(/* @__PURE__ */ new Error("请求体过大"));
		});
		req.on("end", () => {
			if (!body) return resolve(null);
			try {
				resolve(JSON.parse(body));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
	const sendJson = (res, status, obj) => {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(JSON.stringify(obj));
	};
	function metaInfo() {
		return {
			packageRoot: root,
			assetsDir,
			userRoot,
			userConfig: join(userRoot, "main-config.jsonc"),
			helperLog: logFile,
			hasUserConfig: loaded.hasUserConfig,
			electron: existsSync(join(homedir(), ".dsh", "electron", process.platform === "win32" ? "electron.exe" : "electron"))
		};
	}
	async function handle(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(12) || "/" : url.pathname;
		const method = (req.method ?? "GET").toUpperCase();
		if (method === "GET" && (path === "/config" || path === "/")) {
			species = discoverSpecies(paths);
			sendJson(res, 200, {
				config,
				species,
				meta: metaInfo()
			});
			return;
		}
		if (method === "GET" && path === "/state") {
			sendJson(res, 200, {
				helperReady: helper.ready,
				helper: helper.readyInfo,
				workStatus: tracker.current(),
				dshFocused,
				species: species.map((s) => s.id)
			});
			return;
		}
		if (method === "PUT" && path === "/config") {
			const body = await readBody(req);
			if (!body || typeof body !== "object" || body.config === void 0) {
				sendJson(res, 400, { error: "缺少 config 字段" });
				return;
			}
			const normalized = normalizeConfig(body.config);
			const reconciled = reconcileSpecies(normalized.config, species);
			config = reconciled.config;
			const warnings = [...normalized.warnings, ...reconciled.warnings];
			saveConfig(userRoot, config);
			log(`配置已保存（${config.pets.length} 只宠物）${warnings.length ? `，${warnings.length} 条告警` : ""}`);
			helper.restart(helperConfig(config, species));
			sendJson(res, 200, {
				config,
				warnings
			});
			return;
		}
		if (method === "POST" && path === "/dev/notice") {
			const kind = (await readBody(req))?.kind ?? "done";
			const table = {
				done: {
					kind: "done",
					text: "这一轮搞定啦！",
					level: "success",
					toast: true
				},
				error: {
					kind: "error",
					text: "刚才这一步出错了…",
					detail: "（测试提醒）",
					level: "error",
					toast: true
				},
				approval: {
					kind: "approval",
					text: "需要你确认一下～",
					detail: "（测试提醒）",
					level: "attention",
					toast: true
				},
				question: {
					kind: "question",
					text: "有个问题等你回答",
					level: "attention",
					toast: true
				},
				truncated: {
					kind: "truncated",
					text: "输出太长被截断了",
					level: "attention",
					toast: true
				}
			};
			const payload = {
				cmd: "notice",
				...table[kind] ?? table.done,
				toast: config.notifySystemToast,
				dshFocused
			};
			const ok = await helper.send(payload);
			sendJson(res, 200, {
				ok,
				sent: payload,
				helperReady: helper.ready
			});
			return;
		}
		if (method === "POST" && path === "/dev/work") {
			const level = (await readBody(req))?.level ?? "working";
			const index = levelIndex(level);
			await helper.send({
				cmd: "workStatus",
				level,
				index,
				text: pickWorkText(level, index, null)
			});
			sendJson(res, 200, {
				ok: true,
				level
			});
			return;
		}
		if (method === "POST" && path === "/focus") {
			dshFocused = (await readBody(req))?.focused !== false;
			sendJson(res, 200, {
				ok: true,
				dshFocused
			});
			return;
		}
		sendJson(res, 404, { error: `未知端点：${method} ${path}` });
	}
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: (req, res) => {
			handle(req, res).catch((err) => {
				warn(`路由处理失败：${err.message}`);
				try {
					sendJson(res, 500, { error: err.message });
				} catch {}
			});
		}
	}), "dsh-deskpet: 设置页 HTTP 接口");
	log(`插件已装载，接口前缀 ${ROUTE_PREFIX}`);
}
//#endregion
export { apply, inject, name };
