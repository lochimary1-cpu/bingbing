#!/usr/bin/env node
/**
 * 客户端插件契约检查（不需要宿主、不需要浏览器）。
 *
 * 查四件事：
 * 1. lib/client.js 是否是宿主 module loader 认的形态（window.__ModuleLoader__.load）
 * 2. factory(require) 能不能跑通并导出 apply / inject
 * 3. apply(ctx) 是否把组件注册到 conversation.input.activity
 * 4. dsh.client 声明与 exports["./client"] 是否满足宿主校验器 + 文件真实存在
 * 5. 面板后端（lib/l0/panel.js）在临时 DSH_HOME 里切预设是否真的改变期望段
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rows = [];
const add = (id, name, ok, detail) => rows.push({ id, name, ok: Boolean(ok), detail });

/* ── 1. 形态 ──────────────────────────────────────────────────────────── */
const clientPath = path.join(ROOT, "lib", "client.js");
const source = fs.readFileSync(clientPath, "utf8");
add("C1", "bundle 用 __ModuleLoader__.load 包裹", /^\s*window\.__ModuleLoader__\.load\(/.test(source), `${source.length} B`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const clientExport = (() => {
  const value = pkg.exports && pkg.exports["./client"];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.default === "string") return value.default;
  return null;
})();
const exportExists = clientExport ? fs.existsSync(path.join(ROOT, clientExport)) : false;
add("C2", 'exports["./client"] 指向真实文件', exportExists, clientExport || "(缺失)");

const declared = pkg.dsh && pkg.dsh.client;
const declOk = Boolean(declared) && typeof declared.platform === "string" && Array.isArray(declared.inject) && declared.inject.every((x) => typeof x === "string");
add("C3", "dsh.client 声明合法", declOk, declared ? `platform=${declared.platform} inject=[${(declared.inject || []).join(",")}]` : "(缺失)");

/* ── 2/3. 在沙箱里执行 factory 并调 apply ─────────────────────────────── */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  memo: (fn) => fn,
};
const registered = [];
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (entry) => {
        captured = entry;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  },
  document: { head: { appendChild: () => {} }, createElement: () => ({ setAttribute: () => {}, textContent: "" }) },
  fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};
sandbox.globalThis = sandbox;

let factoryError = null;
let exportsObj = null;
try {
  vm.runInNewContext(source, sandbox, { filename: "lib/client.js" });
  if (!captured) throw new Error("没有捕获到 __ModuleLoader__.load 调用");
  const requireStub = (specifier) => {
    if (specifier === "react") return reactStub;
    throw new Error(`bundle 请了未提供的模块：${specifier}`);
  };
  exportsObj = captured.factory(requireStub);
} catch (e) {
  factoryError = String((e && e.message) || e);
}
add("C4", "factory 在沙箱里执行成功", !factoryError, factoryError || `id=${captured && captured.id}`);
add(
  "C5",
  "导出 apply + inject",
  Boolean(exportsObj) && typeof exportsObj.apply === "function" && Array.isArray(exportsObj.inject),
  exportsObj ? `inject=[${(exportsObj.inject || []).join(",")}]` : "(无导出)",
);

let applyError = null;
try {
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  await exportsObj.apply(ctx);
} catch (e) {
  applyError = String((e && e.message) || e);
}
const slot = registered[0];
add(
  "C6",
  "注册到 conversation.input.activity",
  !applyError && Boolean(slot) && slot.spec.name === "conversation.input.activity",
  applyError || (slot ? `key=${slot.spec.key} order=${slot.spec.order}` : "没有注册任何槽位"),
);
add("C7", "组件是可渲染函数", Boolean(slot) && typeof slot.component === "function", slot ? typeof slot.component : "(无)");

/* ── 5. 面板后端：预设切换是否真的改期望段 ────────────────────────────── */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bingbing-panel-"));
process.env.DSH_HOME = HOME;
let panelError = null;
let panel = null;
try {
  const mod = await import(pathToFileURL(path.join(ROOT, "lib", "l0", "panel.js")).href);
  const current = mod.buildState();
  const legacy = mod.applySwitch({ preset: "legacy" });
  const afterLegacy = mod.buildState();
  const kernel = mod.applySwitch({ preset: "kernel" });
  const afterKernel = mod.buildState();
  const off = mod.applySwitch({ preset: "off" });
  const afterOff = mod.buildState();
  mod.applyReset();
  const afterReset = mod.buildState();
  panel = {
    defaultPost: current.expected.post.bytes,
    legacyPost: afterLegacy.expected.post.bytes,
    legacyTail: afterLegacy.effective.tail,
    kernelCore: afterKernel.expected.core.bytes,
    kernelSet: afterKernel.effective.promptSet,
    offCore: afterOff.expected.core.bytes,
    offFiltered: afterOff.effective.enabled,
    resetPost: afterReset.expected.post.bytes,
    resetTail: afterReset.effective.tail,
    legacyPatch: legacy.patch,
    presetId: afterLegacy.preset,
  };
} catch (e) {
  panelError = String((e && e.message) || e);
}
/* 期望值从磁盘现算：尾段会被改写，写死字节数等于给未来埋雷。 */
const sizeOf = (rel) => fs.statSync(path.join(ROOT, rel)).size;
const CURRENT_TAIL = sizeOf("prompts/shell/post.md");
const LEGACY_TAIL = sizeOf("prompts/shell/post.legacy.md");
const KERNEL_CORE = sizeOf("prompts/v2/core.md");

add(
  "C8",
  `预设 legacy 把尾段换成 ${LEGACY_TAIL} B 旧版`,
  !panelError && panel && panel.legacyPost === LEGACY_TAIL && panel.legacyTail === "legacy",
  panelError || (panel ? `post=${panel.legacyPost}B（期望 ${LEGACY_TAIL}B）tail=${panel.legacyTail} preset=${panel.presetId}` : ""),
);
add(
  "C9",
  `预设 kernel 换成 v2 正文（${KERNEL_CORE} B）`,
  !panelError && panel && panel.kernelCore === KERNEL_CORE && panel.kernelSet === "v2",
  panelError || (panel ? `core=${panel.kernelCore}B（期望 ${KERNEL_CORE}B）set=${panel.kernelSet}` : ""),
);
add("C10", "预设 off 清空正文且停用过滤", !panelError && panel && panel.offCore === 0 && panel.offFiltered === false, panelError || (panel ? `core=${panel.offCore}B enabled=${panel.offFiltered}` : ""));
add(
  "C11",
  "复位回到当前尾段",
  !panelError && panel && panel.resetPost === CURRENT_TAIL && panel.resetTail === "current",
  panelError || (panel ? `post=${panel.resetPost}B（期望 ${CURRENT_TAIL}B）tail=${panel.resetTail}` : ""),
);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

const failed = rows.filter((r) => !r.ok);
console.log("");
console.log("bingbing client-plugin contract");
console.log("─".repeat(74));
for (const row of rows) console.log(`[${row.id}] ${row.name.padEnd(34)} ${row.ok ? "PASS" : "FAIL"}  ${row.detail}`);
console.log("─".repeat(74));
console.log(`verdict: ${failed.length ? "FAIL" : "PASS"}  (${rows.length - failed.length}/${rows.length})`);
console.log("");
process.exitCode = failed.length ? 1 : 0;
