(function() {
	//#region src/client/settings.ts
	const API$1 = "/dsh-deskpet";
	const CORNERS = [
		["bottom-right", "右下角"],
		["bottom-left", "左下角"],
		["top-right", "右上角"],
		["top-left", "左上角"]
	];
	const S = {
		wrap: {
			display: "flex",
			flexDirection: "column",
			gap: "14px",
			fontSize: "13px"
		},
		hint: {
			opacity: .62,
			lineHeight: 1.6,
			margin: 0
		},
		card: {
			border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
			borderRadius: "10px",
			padding: "12px",
			display: "flex",
			flexDirection: "column",
			gap: "10px"
		},
		row: {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			flexWrap: "wrap"
		},
		label: {
			minWidth: "64px",
			opacity: .75
		},
		input: {
			padding: "4px 8px",
			borderRadius: "6px",
			border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			width: "88px"
		},
		select: {
			padding: "4px 8px",
			borderRadius: "6px",
			border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
			background: "transparent",
			color: "inherit",
			font: "inherit"
		},
		btn: {
			padding: "5px 12px",
			borderRadius: "7px",
			border: "1px solid color-mix(in srgb, currentColor 26%, transparent)",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			cursor: "pointer"
		},
		btnPrimary: {
			padding: "5px 14px",
			borderRadius: "7px",
			border: "1px solid transparent",
			background: "color-mix(in srgb, currentColor 14%, transparent)",
			color: "inherit",
			font: "inherit",
			fontWeight: 600,
			cursor: "pointer"
		},
		code: {
			opacity: .55,
			fontSize: "12px",
			wordBreak: "break-all"
		},
		msg: {
			padding: "6px 10px",
			borderRadius: "7px",
			background: "color-mix(in srgb, currentColor 8%, transparent)"
		}
	};
	/**
	* @param deps React 注入（h = 手写的 createElement 包装，见 factory.ts）
	*/
	function makeSettingsSection({ h, useState, useEffect }) {
		const Field = ({ label, children }) => h("div", { style: S.row }, h("span", { style: S.label }, label), children);
		const Toggle = ({ label, checked, onChange }) => h("label", { style: {
			...S.row,
			cursor: "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: !!checked,
			onChange: (e) => onChange(e.target.checked)
		}), h("span", null, label));
		return function DeskPetSettings() {
			const [data, setData] = useState(null);
			const [draft, setDraft] = useState(null);
			const [status, setStatus] = useState("");
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			async function load() {
				try {
					const res = await fetch(`${API$1}/config`, { cache: "no-store" });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const json = await res.json();
					setData(json);
					setDraft(json.config);
					setError("");
				} catch (err) {
					setError(`读取配置失败：${err.message}（DSH 主进程是否已加载本插件？）`);
				}
			}
			useEffect(() => {
				load();
			}, []);
			if (error) return h("div", { style: S.wrap }, h("div", { style: {
				...S.msg,
				color: "#e05252"
			} }, error));
			if (!draft) return h("div", { style: S.wrap }, h("p", { style: S.hint }, "正在读取配置…"));
			const speciesList = data?.species ?? [];
			const patch = (fn) => setDraft((prev) => fn(JSON.parse(JSON.stringify(prev))));
			const setPet = (i, key, value) => patch((c) => {
				c.pets[i][key] = value;
				return c;
			});
			const setPos = (i, key, value) => patch((c) => {
				c.pets[i].position[key] = value;
				return c;
			});
			const addPet = () => patch((c) => {
				const first = c.pets[0] ?? {
					size: 190,
					species: speciesList[0]?.id ?? "foxboy",
					position: {
						corner: "bottom-right",
						marginX: 24,
						marginY: 24
					}
				};
				c.pets.push({
					id: `pet${c.pets.length + 1}`,
					name: `桌宠${c.pets.length + 1}`,
					species: first.species,
					size: first.size,
					position: { ...first.position }
				});
				return c;
			});
			const removePet = (i) => patch((c) => {
				c.pets.splice(i, 1);
				return c;
			});
			async function save() {
				setBusy(true);
				setStatus("");
				try {
					const res = await fetch(`${API$1}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ config: draft })
					});
					const json = await res.json();
					if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
					setData((prev) => prev ? {
						...prev,
						config: json.config,
						warnings: json.warnings
					} : {
						config: json.config,
						species: [],
						meta: {},
						warnings: json.warnings
					});
					setDraft(json.config);
					setStatus(json.warnings?.length ? `已保存，但有告警：${json.warnings.join("；")}` : "已保存，宠物已按新配置重启");
					setError("");
				} catch (err) {
					setError(`保存失败：${err.message}`);
				} finally {
					setBusy(false);
				}
			}
			async function tryNotice(kind) {
				setStatus("");
				try {
					await fetch(`${API$1}/dev/notice`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ kind })
					});
					setStatus("已发送，看桌面上的宠物");
				} catch (err) {
					setError(`发送失败：${err.message}`);
				}
			}
			return h("div", { style: S.wrap }, h("p", { style: S.hint }, "宠物住在 Windows 桌面上（独立透明小窗），DSH 收起来之后它照样在；右键宠物可以切换形象、回到初始位置、退出。"), ...draft.pets.map((pet, i) => h("div", {
				style: S.card,
				key: pet.id ?? i
			}, h("div", { style: S.row }, h("strong", null, pet.name || pet.id), h("span", { style: S.code }, pet.id), h("span", { style: { flex: 1 } }), draft.pets.length > 1 ? h("button", {
				style: S.btn,
				onClick: () => removePet(i),
				type: "button"
			}, "删除") : null), h(Field, { label: "名字" }, h("input", {
				style: {
					...S.input,
					width: "140px"
				},
				value: pet.name ?? "",
				onChange: (e) => setPet(i, "name", e.target.value)
			})), h(Field, { label: "形象" }, h("select", {
				style: S.select,
				value: pet.species,
				onChange: (e) => setPet(i, "species", e.target.value)
			}, ...speciesList.map((s) => h("option", {
				key: s.id,
				value: s.id
			}, `${s.name}（${s.id}）`))), h("span", { style: S.code }, `${speciesList.length} 个可用；放新素材到 pet/<id>/idle.png 即出现`)), h(Field, { label: "大小" }, h("input", {
				style: S.input,
				type: "number",
				min: 64,
				max: 600,
				value: pet.size,
				onChange: (e) => setPet(i, "size", Number(e.target.value))
			}), h("span", { style: S.code }, "宽（像素），高度按素材比例自动算")), h(Field, { label: "位置" }, h("select", {
				style: S.select,
				value: pet.position.corner,
				onChange: (e) => setPos(i, "corner", e.target.value)
			}, ...CORNERS.map(([v, label]) => h("option", {
				key: v,
				value: v
			}, label))), h("span", { style: S.code }, "距角落"), h("input", {
				style: S.input,
				type: "number",
				value: pet.position.marginX,
				onChange: (e) => setPos(i, "marginX", Number(e.target.value))
			}), h("input", {
				style: S.input,
				type: "number",
				value: pet.position.marginY,
				onChange: (e) => setPos(i, "marginY", Number(e.target.value))
			})))), h("div", { style: S.row }, h("button", {
				style: S.btn,
				onClick: addPet,
				type: "button"
			}, "+ 添加一只宠物")), h("div", { style: S.card }, h("strong", null, "行为"), h(Toggle, {
				label: "屏幕漫游（没事自己在桌面上溜达）",
				checked: draft.roamEnabled,
				onChange: (v) => patch((c) => (c.roamEnabled = v, c))
			}), h(Toggle, {
				label: "工作状态联动（跟着 DSH 干活状态变姿势）",
				checked: draft.workStatusEnabled,
				onChange: (v) => patch((c) => (c.workStatusEnabled = v, c))
			}), h(Toggle, {
				label: "提醒气泡（干完 / 要你确认 / 出错）",
				checked: draft.notifyEnabled,
				onChange: (v) => patch((c) => (c.notifyEnabled = v, c))
			}), h(Toggle, {
				label: "DSH 不在前台时额外弹系统通知",
				checked: draft.notifySystemToast,
				onChange: (v) => patch((c) => (c.notifySystemToast = v, c))
			}), h(Toggle, {
				label: "点一下宠物就唤起 DeepSeek Harness",
				checked: draft.clickToFocusDsh,
				onChange: (v) => patch((c) => (c.clickToFocusDsh = v, c))
			})), h("div", { style: S.row }, h("button", {
				style: S.btnPrimary,
				onClick: save,
				disabled: busy,
				type: "button"
			}, busy ? "保存中…" : "保存"), h("button", {
				style: S.btn,
				onClick: () => void load(),
				type: "button"
			}, "放弃修改并重载"), h("span", { style: { flex: 1 } }), h("span", { style: S.code }, "试试提醒："), h("button", {
				style: S.btn,
				onClick: () => void tryNotice("done"),
				type: "button"
			}, "干完了"), h("button", {
				style: S.btn,
				onClick: () => void tryNotice("approval"),
				type: "button"
			}, "要你确认"), h("button", {
				style: S.btn,
				onClick: () => void tryNotice("error"),
				type: "button"
			}, "出错了")), status ? h("div", { style: S.msg }, status) : null, error ? h("div", { style: {
				...S.msg,
				color: "#e05252"
			} }, error) : null, h("details", { style: S.card }, h("summary", { style: { cursor: "pointer" } }, "高级：文件位置"), h("div", { style: S.code }, `用户配置：${data?.meta?.userConfig ?? "?"}`), h("div", { style: S.code }, `用户形象目录：${data?.meta?.userRoot ?? "?"}/pet/<id>/idle.png`), h("div", { style: S.code }, `助手日志：${data?.meta?.helperLog ?? "?"}`), h("div", { style: S.code }, "助手运行状态：见 GET /dsh-deskpet/state（设置页只读配置）")));
		};
	}
	//#endregion
	//#region src/client/factory.ts
	const API = "/dsh-deskpet";
	/**
	* 手写 createElement 包装：让设置页可以 `h('div', props, a, b, c)` 变长传子节点。
	* 不用 react/jsx-runtime 是为了避免 JSX 编译产出静态 import（那会把 React 打进包里，
	* 而 React 必须由 DSH 在运行时注入）。
	* 返回值在对调用方处断言成 React.createElement 的类型，这样设置页里的事件回调
	* 能吃到 React 的重载推导（类型只在编译期，运行时没有任何 React 导入）。
	*/
	function createH(React) {
		return function h(type, props, ...children) {
			const p = props ? { ...props } : {};
			const flat = children.flat(Infinity).filter((c) => c !== null && c !== void 0 && c !== false);
			if (flat.length === 1) p.children = flat[0];
			else if (flat.length > 1) p.children = flat;
			return React.createElement(type, p);
		};
	}
	/** 返回 DSH 插件 factory：`(require) => module`，module 上是 name/inject/apply 三件套 */
	function makeFactory() {
		return (require) => {
			const module = { exports: {} };
			const React = require("react");
			const SettingsSection = makeSettingsSection({
				h: createH(React),
				useState: React.useState,
				useEffect: React.useEffect
			});
			const name = "deskpet";
			const inject = ["slots"];
			function apply(ctx) {
				ctx.effect(() => {
					const report = () => {
						const focused = document.hasFocus() && document.visibilityState === "visible";
						fetch(`${API}/focus`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ focused })
						}).catch(() => {});
					};
					report();
					const onVis = () => report();
					window.addEventListener("focus", report);
					window.addEventListener("blur", report);
					document.addEventListener("visibilitychange", onVis);
					return () => {
						window.removeEventListener("focus", report);
						window.removeEventListener("blur", report);
						document.removeEventListener("visibilitychange", onVis);
					};
				}, "dsh-deskpet: focus reporter");
				ctx.slots.inject("settings.section", function* () {
					yield ctx.slots.register({
						name: "settings.section",
						id: "deskpet",
						order: 35,
						label: () => "桌面宠物"
					}, SettingsSection);
				});
			}
			module.exports = {
				apply,
				inject,
				name
			};
			return module.exports;
		};
	}
	//#endregion
	//#region src/client/index.ts
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
	window.__ModuleLoader__.load({
		id: "dsh-deskpet",
		factory: makeFactory()
	});
	//#endregion
})();
