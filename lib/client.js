window.__ModuleLoader__.load({
	id: "bingbing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		// ---- styles -------------------------------------------------------
		// cold-tiger / brutalism（动效照搬 Uiverse.io by 0xnihilism，MIT）。
		// 与 ui/index.html 是同一套视觉语言，两份 CSS 必须一起改，别只改一处。
		// 三处刻意调整：闪烁 .5→.32（11px 数据表不能被闪花）、边框 10→6px、眼睛贴右下角。
		const CSS = `
.bb-dock { display: inline-flex; align-items: center; }
.bb-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
  border: 2px solid #5a5442; background: #141310; color: #d8d1b8;
  font: 700 10px/1 "Courier New", ui-monospace, monospace; letter-spacing: 1.2px;
  text-transform: uppercase; cursor: pointer; box-shadow: 2px 2px 0 #000;
  transition: transform .09s steps(2), box-shadow .09s steps(2), border-color .12s, color .12s, background .12s;
}
.bb-btn:hover { border-color: rgb(198,181,113); color: #fff; background: #241f16; }
.bb-btn:active { transform: translate(2px,2px); box-shadow: 0 0 0 #000; }
.bb-dot { width: 7px; height: 7px; background: #8fe39b; flex: none; }
.bb-dot.off { background: #ff6b5e; }
.bb-dot.pending { background: #e8b45c; }

.bb-panel {
  position: fixed; right: 16px; bottom: 92px; width: 400px; z-index: 9999;
  background: #1c1a16; color: #e8e2cf;
  border: 6px solid rgb(161,156,116); box-shadow: 6px 8px 0 #000;
  overflow: hidden; isolation: isolate;
  font: 12px/1.6 "Courier New", ui-monospace, Consolas, monospace;
}
/* 扫描线（tv-static）*/
.bb-scan {
  position: absolute; inset: 0; z-index: 7; pointer-events: none; opacity: .26;
  background: repeating-linear-gradient(0deg, rgba(255,255,255,.05) 0 1px, transparent 1px 2px);
  animation: bb-static .2s infinite linear alternate;
}
@keyframes bb-static { 0% { opacity: .26 } 100% { opacity: .12 } }
/* 扫过的一条灰线 */
.bb-sweep {
  position: absolute; left: 0; right: 0; height: 4px; z-index: 8; pointer-events: none;
  background: rgba(75,68,68,.5); animation: bb-scanmove 3.2s linear infinite;
}
@keyframes bb-scanmove { 0% { top: 0 } 100% { top: 100% } }
/* Big Brother 的眼球：贴右下角出血，只露一只。
   源自同一作者的 brown-puma-30（原版 280×280 展示框），缩成眼角装饰；
   白眼球在暗底上对比极强，所以整体压到 .45，且只占角落，不碰表格数据。*/
.bb-eye {
  position: absolute; right: -56px; bottom: -22px; width: 172px; height: 64px;
  z-index: 1; pointer-events: none; opacity: .40;
}
.bb-sclera {
  position: absolute; inset: 0; background: #fff; border-radius: 50%; overflow: hidden;
  animation: bb-pulse 2s infinite;
}
@keyframes bb-pulse { 0%,100% { transform: scale(1) } 50% { transform: scale(1.05) } }
.bb-pupil {
  position: absolute; top: 50%; left: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px;
  background: #000; border-radius: 50%; animation: bb-look 4s infinite ease-in-out;
}
@keyframes bb-look { 0%,100% { transform: translateX(0) } 25% { transform: translateX(9px) } 75% { transform: translateX(-9px) } }
.bb-pupil::after {
  content: ""; position: absolute; top: 50%; left: 50%; width: 20px; height: 20px;
  margin: -10px 0 0 -10px; border-radius: 50%;
  background: radial-gradient(circle, #ff2b2b 0%, transparent 70%);
}
.bb-lid {
  position: absolute; left: 0; right: 0; top: 0; height: 0; background: #1c1a16;
  animation: bb-blink 4s infinite;
}
@keyframes bb-blink { 0%, 90%, 100% { height: 0 } 95% { height: 100% } }

.bb-inner { position: relative; z-index: 5; padding: 12px; max-height: 66vh; overflow: auto; }
.bb-head { display: flex; align-items: center; gap: 8px; margin-bottom: 11px; }
.bb-title {
  position: relative; display: inline-block; font-weight: 700; font-size: 12px;
  letter-spacing: 2.2px; text-transform: uppercase; color: #fff; text-shadow: 2px 2px #000;
}
.bb-title::before, .bb-title::after { content: attr(data-text); position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
.bb-title::before { left: 1.5px; text-shadow: -1px 0 red; animation: bb-g1 2s infinite linear alternate-reverse; }
.bb-title::after { left: -1.5px; text-shadow: -1px 0 #0ff; animation: bb-g2 3s infinite linear alternate-reverse; }
@keyframes bb-g1 { 0% { clip: rect(6px,9999px,10px,0) } 100% { clip: rect(12px,9999px,15px,0) } }
@keyframes bb-g2 { 0% { clip: rect(3px,9999px,7px,0) } 100% { clip: rect(10px,9999px,2px,0) } }
.bb-pill {
  font: 700 9.5px/1 "Courier New", ui-monospace, monospace; letter-spacing: 1.3px; text-transform: uppercase;
  padding: 4px 7px; border: 1px solid #5a5442; color: #a9a288; background: #141310;
}
.bb-pill.ok { color: #8fe39b; border-color: rgba(143,227,155,.5); background: rgba(10,26,14,.8); }
.bb-pill.bad { color: #ff6b5e; border-color: rgba(255,107,94,.45); background: rgba(28,10,9,.8); }
.bb-pill.warn { color: #e8b45c; border-color: rgba(232,180,92,.45); background: rgba(28,20,6,.8); }
.bb-x { margin-left: auto; background: none; border: 0; color: #a9a288; cursor: pointer; font: 700 15px/1 "Courier New", monospace; padding: 2px 5px; }
.bb-x:hover { color: #fff; }

.bb-presets { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 11px; }
.bb-preset {
  position: relative; text-align: left; padding: 7px 9px; cursor: pointer;
  border: 2px solid #5a5442; background: #141310; color: #d8d1b8;
  font: 11px/1.35 "Courier New", ui-monospace, monospace; box-shadow: 3px 3px 0 #000;
  transition: transform .09s steps(2), box-shadow .09s steps(2), border-color .12s, background .12s, color .12s;
}
.bb-preset:hover { border-color: rgb(198,181,113); color: #fff; background: #241f16; }
.bb-preset:active { transform: translate(3px,3px); box-shadow: 0 0 0 #000; }
.bb-preset.sel { border-color: rgb(198,181,113); background: rgb(198,181,113); color: #14130f; }
.bb-preset b { display: block; font-size: 11.5px; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 2px; }
.bb-preset span { color: #6b6656; font-size: 10px; letter-spacing: .3px; }
.bb-preset.sel span { color: #3a3528; }

/* 版本区：和预设区同一条视觉语言，但更矮，避免把证据表挤出屏幕 */
.bb-vers { margin: 2px 0 11px; border: 2px solid #43402f; background: #17150f; padding: 7px 8px 8px; }
.bb-vers-head { display: flex; align-items: center; gap: 7px; }
.bb-vers-head b { font-size: 10.5px; letter-spacing: 1.1px; text-transform: uppercase; color: #d8d1b8; }
.bb-vers-head .bb-ghost { margin-left: auto; }
.bb-vers-head .bb-ghost + .bb-ghost { margin-left: 0; }
.bb-vers-list { margin-top: 6px; border-top: 1px dashed rgba(115,112,92,.45); padding-top: 5px; }
.bb-vers-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 10.5px; }
.bb-vers-row .bb-muted { margin-left: auto; color: #6b6656; font-size: 9.5px; }
.bb-muted { color: #6b6656; }
.bb-ghost.acc { border-color: rgb(198,181,113); color: #14130f; background: rgb(198,181,113); }
.bb-ghost.acc:hover { color: #14130f; background: #d8c98a; }
.bb-ghost:disabled, .bb-preset:disabled { opacity: .45; cursor: default; }

.bb-table { width: 100%; border-collapse: collapse; margin-top: 4px; table-layout: fixed; }
.bb-table th {
  text-align: left; font-size: 9px; letter-spacing: 1.4px; text-transform: uppercase; color: #6b6656;
  padding: 4px 3px; border-bottom: 2px solid #5a5442;
}
.bb-table td { padding: 5px 3px; border-bottom: 1px dashed rgba(115,112,92,.45); font-size: 10.5px; vertical-align: top; color: #ddd6c0; }
.bb-table th:nth-child(1), .bb-table td:nth-child(1) { width: 62px; white-space: nowrap; }
.bb-table th:nth-child(4), .bb-table td:nth-child(4) { width: 18px; text-align: right; }
.bb-mono { font-family: "Courier New", ui-monospace, monospace; font-size: 10px; color: #b9b294; }
.bb-ok { color: #8fe39b; font-weight: 700; }
.bb-bad { color: #ff6b5e; font-weight: 700; }
.bb-note { margin-top: 9px; padding: 8px 9px; font-size: 10px; line-height: 1.6; letter-spacing: .2px; }
.bb-note.warn { border: 1px dashed rgba(232,180,92,.5); background: rgba(28,20,6,.75); color: #e8b45c; }
.bb-note.bad { border: 1px dashed rgba(255,107,94,.45); background: rgba(28,10,9,.75); color: #ffb4ae; }
.bb-note.ok { border: 1px dashed rgba(143,227,155,.45); background: rgba(10,26,14,.75); color: #8fe39b; }
.bb-foot { margin-top: 9px; display: flex; gap: 7px; align-items: center; }
.bb-ghost {
  background: #141310; color: #a9a288; border: 2px solid #5a5442; padding: 4px 9px; cursor: pointer;
  font: 700 9.5px/1 "Courier New", ui-monospace, monospace; letter-spacing: 1.2px; text-transform: uppercase;
  box-shadow: 2px 2px 0 #000; transition: transform .09s steps(2), box-shadow .09s steps(2), border-color .12s, color .12s;
}
.bb-ghost:hover { border-color: rgb(198,181,113); color: #fff; }
.bb-ghost:active { transform: translate(2px,2px); box-shadow: 0 0 0 #000; }
.bb-dim { color: #6b6656; font-size: 9px; letter-spacing: .2px; word-break: break-all; }

@media (prefers-reduced-motion: reduce) {
  .bb-scan, .bb-sweep, .bb-title::before, .bb-title::after,
  .bb-sclera, .bb-pupil, .bb-lid { animation: none !important; }
  .bb-btn, .bb-preset, .bb-ghost { transition: none !important; }
}
`;
		let styleInstalled = false;
		const ensureStyle = () => {
			if (styleInstalled || typeof document === "undefined") return;
			styleInstalled = true;
			const el = document.createElement("style");
			el.setAttribute("data-bingbing", "");
			el.textContent = CSS;
			document.head.appendChild(el);
		};

		// ---- api ----------------------------------------------------------
		// 面板服务由宿主内的 bingbing 插件自己起（只绑 127.0.0.1），端口从 7312 起找空位，
		// 所以这里按端口探测 /ping，认到 service=bingbing-panel 才用它。
		const PORT_BASE = 7312;
		const PORT_TRIES = 10;
		let apiBase = null;

		const probeOnce = async (port) => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/ping`, { cache: "no-store" });
				if (!response.ok) return null;
				const body = await response.json();
				return body && body.service === "bingbing-panel" ? `http://127.0.0.1:${port}` : null;
			} catch {
				return null;
			}
		};

		const resolveBase = async () => {
			if (apiBase) return apiBase;
			for (let index = 0; index < PORT_TRIES; index += 1) {
				const hit = await probeOnce(PORT_BASE + index);
				if (hit) {
					apiBase = hit;
					return apiBase;
				}
			}
			throw new Error("面板服务没响应：宿主里的 bingbing 面板没启动（看 $DSH_HOME/state/bingbing/status.json 的 panel 字段）");
		};

		const call = async (path, init) => {
			const doOnce = async () => fetch(`${await resolveBase()}${path}`, init);
			let response;
			try {
				response = await doOnce();
			} catch (cause) {
				apiBase = null; // 端口变了：重探一次
				response = await doOnce();
			}
			const text = await response.text();
			let body;
			try {
				body = JSON.parse(text);
			} catch {
				body = { error: text.slice(0, 200) };
			}
			if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
			return body;
		};
		const fmtPart = (part) => (part ? `${part.bytes} B · ${String(part.sha256).slice(0, 10)}` : "缺失");

		const PRESET_HINT = {
			legacy: "正文 + 376 B 旧尾段",
			current: "正文 + 1757 B 机制尾段",
			kernel: "v2 内核 + 机制尾段",
			off: "清空三段、不过滤",
		};

		const h = react.createElement;

		function BingbingBar() {
			const [open, setOpen] = react.useState(false);
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [versions, setVersions] = react.useState(null);
			const [upd, setUpd] = react.useState(null);
			const [notice, setNotice] = react.useState(null);

			const loadVersions = react.useCallback(async () => {
				try {
					setVersions(await call("/versions"));
				} catch {
					/* 老宿主没有这个路由：不显示版本区，不报错 */
				}
			}, []);

			const load = react.useCallback(async () => {
				try {
					setState(await call("/state"));
					await loadVersions();
					setError(null);
				} catch (cause) {
					setError(String(cause && cause.message ? cause.message : cause));
				}
			}, [loadVersions]);

			react.useEffect(() => {
				ensureStyle();
				load();
			}, [load]);

			react.useEffect(() => {
				if (!open) return undefined;
				load();
				const timer = setInterval(load, 4000);
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => {
					clearInterval(timer);
					window.removeEventListener("keydown", onKey);
				};
			}, [open, load]);

			const send = async (patch) => {
				if (busy) return;
				setBusy(true);
				try {
					await call("/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
					await load();
				} catch (cause) {
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			const reset = async () => {
				if (busy) return;
				setBusy(true);
				try {
					await call("/reset", { method: "POST" });
					await load();
				} catch (cause) {
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			const checkUpdate = async () => {
				if (busy) return;
				setBusy(true);
				setNotice("正在检查更新…");
				try {
					const result = await call("/update/check", { method: "POST" });
					setUpd(result);
					setNotice(result.rows && result.rows.length ? null : "远端还没有可安装的 release");
				} catch (cause) {
					setNotice(null);
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			/** install=true 时先下载再激活；否则只激活已装版本。 */
			const useVersion = async (version, installFirst) => {
				if (busy || !version) return;
				setBusy(true);
				setNotice(installFirst ? `正在下载 ${version}…` : `正在切到 ${version}…`);
				try {
					if (installFirst) await call("/update/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) });
					await call("/update/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) });
					await load();
					setUpd(null);
					setNotice(`已切到 ${version}：双击 $DSH_HOME/state/bingbing/restart.cmd 重启后生效`);
				} catch (cause) {
					setNotice(null);
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			const doRollback = async () => {
				if (busy) return;
				setBusy(true);
				try {
					const result = await call("/update/rollback", { method: "POST" });
					await load();
					setNotice(`已回滚到 ${result.to}，重启后生效`);
				} catch (cause) {
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			/** 只生成 restart.cmd，不杀进程：用户双击，或在资源管理器里打开它。 */
			const makeRestart = async () => {
				if (busy) return;
				setBusy(true);
				try {
					const result = await call("/update/restart", { method: "POST" });
					setNotice(`已生成重启脚本：${result.restart.path}（双击即可重启宿主）`);
					await loadVersions();
				} catch (cause) {
					setError(String(cause && cause.message ? cause.message : cause));
				} finally {
					setBusy(false);
				}
			};

			const effective = state && state.effective ? state.effective : null;
			const evidence = state && state.evidence ? state.evidence : null;
			const dotClass = !effective || !effective.enabled ? "bb-dot off" : evidence && (evidence.pending || evidence.codeStale) ? "bb-dot pending" : "bb-dot";
			const label = !effective ? "越狱" : !effective.enabled ? "越狱·关" : effective.promptSet === "v2" ? "越狱·内核" : effective.tail === "legacy" ? "越狱·旧" : "越狱·新";

			const badge = !evidence
				? { text: "读取中", cls: "bb-pill" }
				: evidence.codeStale
					? { text: "需重启", cls: "bb-pill bad" }
					: evidence.matched
						? { text: "已生效", cls: "bb-pill ok" }
						: evidence.pending
							? { text: "待组装", cls: "bb-pill warn" }
							: { text: "不一致", cls: "bb-pill bad" };

			const rows = (state && state.rows) || [];
			const presets = (state && state.presets) || [];

			return h(
				"span",
				{ className: "bb-dock" },
				h(
					"button",
					{
						type: "button",
						className: "bb-btn",
						title: "bingbing 越狱开关台",
						onClick: () => setOpen(!open),
					},
					h("span", { className: dotClass }),
					label,
				),
				open
					? h(
							"div",
							{ className: "bb-panel", role: "dialog", "aria-label": "bingbing 越狱开关台" },
							h(
								"span",
								{ className: "bb-eye", "aria-hidden": "true" },
								h("i", { className: "bb-sclera" }, h("i", { className: "bb-pupil" }), h("i", { className: "bb-lid" })),
							),
							h("span", { className: "bb-sweep", "aria-hidden": "true" }),
							h("span", { className: "bb-scan", "aria-hidden": "true" }),
							h(
								"div",
								{ className: "bb-inner" },
							h(
								"div",
								{ className: "bb-head" },
								h("span", { className: "bb-title", "data-text": "bingbing 开关台" }, "bingbing 开关台"),
								h("span", { className: badge.cls }, badge.text),
								h("button", { type: "button", className: "bb-x", onClick: () => setOpen(false), title: "关闭 (Esc)" }, "×"),
							),
							error ? h("div", { className: "bb-note bad" }, error) : null,
							h(
								"div",
								{ className: "bb-presets" },
								presets.map((preset) =>
									h(
										"button",
										{
											key: preset.id,
											type: "button",
											disabled: busy,
											className: `bb-preset${state && state.preset === preset.id ? " sel" : ""}`,
											onClick: () => send({ preset: preset.id }),
										},
										h("b", null, preset.id === "legacy" ? "旧越狱" : preset.id === "current" ? "当前越狱" : preset.id === "kernel" ? "机制内核" : "关闭"),
										h("span", null, PRESET_HINT[preset.id] || preset.label),
									),
								),
							),
							versions
								? h(
										"div",
										{ className: "bb-vers" },
										h(
											"div",
											{ className: "bb-vers-head" },
											h("b", null, `版本 ${versions.running || versions.active || "未设置"}`),
											versions.activeKind === "linked" ? h("span", { className: "bb-mono" }, "开发") : null,
											h("button", { type: "button", className: "bb-ghost", onClick: checkUpdate, disabled: busy }, "检查更新"),
											upd && upd.updateAvailable ? h("button", { type: "button", className: "bb-ghost acc", onClick: () => useVersion(upd.latest, true), disabled: busy }, `更新到 ${upd.latest}`) : null,
											h("button", { type: "button", className: "bb-ghost", onClick: makeRestart, disabled: busy, title: "生成 restart.cmd：双击即可重启宿主" }, "重启"),
										),
										versions.pending ? h("div", { className: "bb-note warn" }, `已切到 ${versions.pending.to}：重启后生效（60 秒自检不过自动回滚）`) : null,
										versions.rollbackNeeded
											? h("div", { className: "bb-note bad" }, `上次自动回滚 ${versions.rollbackNeeded.from} → ${versions.rollbackNeeded.to}，再重启一次`)
											: null,
										notice ? h("div", { className: "bb-note" }, notice) : null,
										versions.versions && versions.versions.length
											? h(
													"div",
													{ className: "bb-vers-list" },
													versions.versions.map((item) =>
														h(
															"div",
															{ key: item.ver, className: "bb-vers-row" },
															h("span", { className: "bb-mono" }, item.ver),
															item.active
																? h("span", { className: "bb-ok" }, "当前")
																: h("button", { type: "button", className: "bb-ghost", disabled: busy, onClick: () => useVersion(item.ver, false) }, "切换"),
															h("span", { className: "bb-muted" }, item.installedAt ? new Date(item.installedAt).toLocaleDateString() : ""),
														),
													),
												)
											: h("div", { className: "bb-note" }, upd && upd.rows && upd.rows.length ? "还没有本地版本，点上面的「更新到 …」" : "还没有本地版本"),
										versions.pending || versions.rollbackNeeded
											? h("button", { type: "button", className: "bb-ghost", onClick: doRollback, disabled: busy }, "回滚")
											: null,
									)
								: null,
							h(
								"table",
								{ className: "bb-table" },
								h("thead", null, h("tr", null, h("th", null, "段"), h("th", null, "期望"), h("th", null, "实际"), h("th", null, ""))),
								h(
									"tbody",
									rows.map((row) =>
										h(
											"tr",
											{ key: row.part },
											h("td", null, row.label),
											h("td", { className: "bb-mono" }, row.textual ? row.expectedText : fmtPart(row.expected)),
											h("td", { className: "bb-mono" }, row.textual ? row.actualText : fmtPart(row.actual)),
											h("td", { className: row.ok ? "bb-ok" : "bb-bad" }, row.ok ? "✓" : "✗"),
										),
									),
								),
							),
							evidence
								? h(
										"div",
										{ className: `bb-note ${evidence.matched ? "ok" : evidence.pending || evidence.codeStale ? "warn" : "bad"}` },
										evidence.summary,
										evidence.snapshotAt ? ` ｜ 快照 ${new Date(evidence.snapshotAt).toLocaleTimeString()}` : "",
									)
								: null,
							h(
								"div",
								{ className: "bb-foot" },
								h("button", { type: "button", className: "bb-ghost", onClick: load, disabled: busy }, "刷新"),
								h("button", { type: "button", className: "bb-ghost", onClick: reset, disabled: busy }, "复位"),
							),
							),
						)
					: null,
			);
		}

		// ---- registration -------------------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				ensureStyle();
			}, "bingbing: style");
			ctx.slots.inject("conversation.input.activity", () =>
				ctx.slots.register(
					{
						name: "conversation.input.activity",
						key: "bingbing",
						order: 50,
					},
					BingbingBar,
				),
			);
		}

		exports.BingbingBar = BingbingBar;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
