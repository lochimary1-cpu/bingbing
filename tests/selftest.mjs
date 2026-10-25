#!/usr/bin/env node
/**
 * bingbing 自测：不装宿主、不联网、不碰真实状态。
 * 用假的 ctx 把 apply() 与 waterfall 跑一遍，再断言静态探针 S1–S5。
 *
 * 用法：node tests/selftest.mjs        （全过退出 0，任一条失败退出 1）
 *       node tests/selftest.mjs -v     （打印每条断言的细节）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const verbose = process.argv.includes("-v");
// 自测里不要真起面板端口：apply() 会启动本地 HTTP 服务，这里只需要机制。
process.env.BINGBING_NO_PANEL = "1";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bingbing-selftest-"));
process.env.DSH_HOME = HOME;

const CORE_TEXT = `SELFTEST CORE PROMPT\n${"placeholder line for the core section\n".repeat(30)}`;
fs.writeFileSync(path.join(HOME, "prompt-inject.md"), CORE_TEXT, "utf8");

const { apply } = await import("../lib/index.js");
const { staticProbes } = await import("../lib/core/canary.js");
const { resolveCore } = await import("../lib/l0/prompt.js");
const { BOOT_ID } = await import("../lib/core/state.js");

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail });
  if (verbose) console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

// ---- 假宿主 ----------------------------------------------------------------
const seen = { sections: [], handlers: [], tools: [] };

function makeHost({ failSection = false } = {}) {
  const service = {
    section(spec) {
      if (failSection) throw new Error("section() refused in test");
      seen.sections.push(spec);
      return () => {};
    },
    getSectionOrder(name) {
      if (name === "DEPLOYMENT_PERSONA_PREFIX") return 0;
      if (name === "DEPLOYMENT_PERSONA_SUFFIX") return 10200;
      return undefined;
    },
  };
  const inner = { systemPrompt: service };
  const ctx = {
    systemPrompt: { ctx: inner },
    on(name, fn) {
      seen.handlers.push({ name, fn });
      return () => {};
    },
    tools: {
      register(def) {
        seen.tools.push(def);
        return () => {};
      },
    },
  };
  return ctx;
}

function buildAssembly(sections) {
  return {
    sections: [
      { name: "harness:identity", order: -1000, text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "deployment:persona-suffix", order: 10200, text: "persona tail" },
      ...sections.map((spec) => ({
        name: spec.name,
        order: spec.order,
        text: typeof spec.text === "function" ? spec.text() : spec.text,
      })),
    ],
    contexts: [
      { name: "approval:policy", text: "Approval prompts are disabled; do not request sandbox escalation." },
      { name: "working-directory", text: "cwd = C:\\x" },
    ],
    tools: [],
    variables: {},
  };
}

// ---- 1. apply() -----------------------------------------------------------
const ctx = makeHost();
let applied = null;
try {
  applied = apply(ctx, { promptSet: "v1+shell", trace: true });
} catch (e) {
  check("A0", false, `apply() 抛错：${e && e.message}`);
}

check("A1", seen.sections.length === 3, `注册段数 ${seen.sections.length}（期望 3）`);
const names = seen.sections.map((s) => s.name).sort().join(",");
check("A2", names === "bingbing:core,bingbing:post,bingbing:pre", `段名 ${names}`);
const byName = Object.fromEntries(seen.sections.map((s) => [s.name, s.order]));
check("A3", byName["bingbing:pre"] === 1, `pre order = ${byName["bingbing:pre"]}（期望 1）`);
check("A4", byName["bingbing:post"] === 10201, `post order = ${byName["bingbing:post"]}（期望 10201）`);
check("A5", seen.handlers.some((h) => h.name === "system-prompt/assemble"), "waterfall 已挂");
check("A6", seen.tools.length === 1 && seen.tools[0].name === "bingbing_status", `工具 ${seen.tools.map((t) => t.name).join(",") || "无"}`);
const def = seen.tools[0];
check(
  "A7",
  Boolean(def && def.output && typeof def.output.render === "function" && typeof def.execute === "function"),
  "ToolDefinition 含 output.render + execute（宿主契约要求）",
);
check("A8", applied && applied.reason === "ok", `apply().reason = ${applied && applied.reason}`);

// ---- 2. waterfall 行为 ----------------------------------------------------
const handler = seen.handlers.find((h) => h.name === "system-prompt/assemble").fn;
const assembly = buildAssembly(seen.sections);
const out = await handler(assembly, { agent: { id: "test" } }, async () => assembly);

check("W1", out !== assembly, "waterfall 返回了新对象（未原地改调用方对象）");
// M2 起默认 rewrite：政策段保留段名与位置，只换文本，所以数量不变
const policyOut = out.contexts.find((c) => c.name === "approval:policy");
check(
  "W2",
  out.contexts.length === 2 && Boolean(policyOut) && !/approval prompts are disabled/i.test(String(policyOut && policyOut.text)),
  `contexts=${out.contexts.map((c) => c.name).join(",")}；政策段文本已替换=${Boolean(policyOut)}`,
);
check("W3", !out.sections.some((s) => s.name === "harness:identity"), "identity 段被过滤");
check("W4", out.sections.some((s) => s.name === "bingbing:post"), "post 段仍在");
// 快照必须带进程标识：没有它就分不清"本进程刚组装过"和"读到上一个进程的旧快照"
const bootSnap = JSON.parse(fs.readFileSync(path.join(HOME, "state", "bingbing", "last-assembly.json"), "utf8"));
check("W5", bootSnap.bootId === BOOT_ID, `装配快照带本进程 bootId：${String(bootSnap.bootId).slice(0, 8)}…`);

// ---- 2.5 M2：结构对等 / M4：工具描述契约 ----------------------------------
const sameContextNames =
  out.contexts.map((c) => c.name).join(",") === assembly.contexts.map((c) => c.name).join(",");
check(
  "M2a",
  sameContextNames && out.contexts.length === assembly.contexts.length,
  `结构对等：出 ${out.contexts.length} / 入 ${assembly.contexts.length}，段名一致=${sameContextNames}`,
);

const ctxDrop = makeHost();
apply(ctxDrop, { promptSet: "v1+shell", trace: false, policyMode: "drop" });
const handlerDrop = seen.handlers.filter((h) => h.name === "system-prompt/assemble").pop().fn;
const asmDrop = buildAssembly([]);
const outDrop = await handlerDrop(asmDrop, {}, async () => asmDrop);
check("M2b", outDrop.contexts.length === 1, `drop 模式 contexts=${outDrop.contexts.length}（期望 1，旧行为可切回）`);

check(
  "M4a",
  Boolean(def && /Session scope is already decided/.test(String(def.description))),
  "工具描述默认含运行契约（M4）",
);

const ctxNoTool = makeHost();
apply(ctxNoTool, { promptSet: "v1+shell", trace: false, toolContract: false });
const toolOff = seen.tools[seen.tools.length - 1];
check(
  "M4b",
  Boolean(toolOff) && !/Session scope is already decided/.test(String(toolOff.description)),
  "toolContract:false 时工具描述不含契约",
);

// ---- 3. 负向对照：关掉过滤应当保留政策 context ---------------------------
const ctxOff = makeHost();
apply(ctxOff, { promptSet: "v1", trace: false, filterPolicyContexts: false, filterIdentitySections: false });
const handlerOff = seen.handlers.filter((h) => h.name === "system-prompt/assemble").pop().fn;
const assemblyOff = buildAssembly(ctxOff ? seen.sections.slice(-1) : []);
const outOff = await handlerOff(assemblyOff, {}, async () => assemblyOff);
check("N1", outOff.contexts.length === 2, `关闭过滤后 contexts 数 ${outOff.contexts.length}（期望 2）`);
check("N2", outOff.sections.some((s) => s.name === "harness:identity"), "关闭过滤后 identity 段仍在");

// ---- 4. 静态探针 ----------------------------------------------------------
const core = resolveCore({ promptSet: "v1+shell" });
const probes = staticProbes(core);
for (const probe of probes.probes) {
  check(probe.id, probe.ok === true, `${probe.name} — ${probe.detail}`);
}
check("V0", probes.summary.verdict === "PASS", `verdict = ${probes.summary.verdict}`);

// ---- 5. 活读正文：改文件后下一次组装必须取到新内容 -------------------------
// 回归点：早期版本把正文冻结在 apply() 时刻，改 prompt-inject.md 不生效。
const EDITED = `EDITED CORE ${Date.now()}\n${"y".repeat(200)}`;
fs.writeFileSync(path.join(HOME, "prompt-inject.md"), EDITED, "utf8");
const assembly2 = buildAssembly(seen.sections.slice(0, 3));
await handler(assembly2, { agent: { id: "test" } }, async () => assembly2);
const { createHash } = await import("node:crypto");
const expectedSha = createHash("sha256").update(Buffer.from(EDITED, "utf8")).digest("hex");
const snapshotPath = path.join(HOME, "state", "bingbing", "last-assembly.json");
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
check(
  "R1",
  Boolean(snap.core) && snap.core.sha256 === expectedSha,
  `组装时 ${String(snap.core && snap.core.sha256).slice(0, 12)} / 期望 ${expectedSha.slice(0, 12)}`,
);
check("R2", snap.source === "pre-restore", `snapshot.source = ${snap.source}`);

// ---- 6. 快照签名必须覆盖 pre/post：只改 post 也必须重写 last-assembly ----------
// 回归点：早期签名只含 core 的 sha，改 post.md 时签名不变 → 快照永远停在旧内容，
// 于是"证据"说谎（线上 post 已换，快照还写着旧的 bytes/sha）。
const mkAssembly = (postText) => ({
  sections: [
    { name: "deployment:persona-prefix", text: "prefix" },
    { name: "bingbing:pre", text: "PRE-FIXED" },
    { name: "bingbing:core", text: EDITED },
    { name: "bingbing:post", text: postText },
  ],
  contexts: [{ name: "working-directory", text: "cwd" }],
  tools: [],
  variables: {},
});
const shaOf = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const postShaIn = (snapshot) => String((snapshot.sections.find((s) => s.name === "bingbing:post") || {}).sha256 || "");

await handler(null, {}, async () => mkAssembly("POST-VARIANT-A"));
const snapA = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
await handler(null, {}, async () => mkAssembly("POST-VARIANT-B"));
const snapB = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

check(
  "R3",
  postShaIn(snapA) === shaOf("POST-VARIANT-A") && postShaIn(snapB) === shaOf("POST-VARIANT-B"),
  `post 快照 A=${postShaIn(snapA).slice(0, 12)} B=${postShaIn(snapB).slice(0, 12)}（应各自与 A/B 内容一致）`,
);

// ---- 7. 运行时覆盖：切换 promptSet / enabled 必须热生效（UI 的后端契约）----
// 契约：段的注册只发生一次，内容由 thunk 每次组装按 override.json 决定。
const ov = await import("../lib/l0/override.js");
const textOf = (name) => {
  const spec = seen.sections.find((s) => s.name === name);
  if (!spec) return null;
  return typeof spec.text === "function" ? spec.text() : spec.text;
};

check(
  "O1",
  (textOf("bingbing:pre") || "").length > 0 && (textOf("bingbing:post") || "").length > 0,
  `v1+shell：pre=${(textOf("bingbing:pre") || "").length}B post=${(textOf("bingbing:post") || "").length}B`,
);

ov.writeOverride({ promptSet: "v1" });
check(
  "O2",
  textOf("bingbing:pre") === "" && textOf("bingbing:post") === "" && (textOf("bingbing:core") || "").length > 0,
  `切 v1：pre=${(textOf("bingbing:pre") || "").length}B post=${(textOf("bingbing:post") || "").length}B core=${(textOf("bingbing:core") || "").length}B`,
);

const v1Core = textOf("bingbing:core");
ov.writeOverride({ promptSet: "v2" });
const v2Core = textOf("bingbing:core");
check(
  "O3",
  Boolean(v2Core) && v2Core !== v1Core && (textOf("bingbing:pre") || "").length > 0,
  `切 v2：core=${(v2Core || "").length}B 与 v1 不同=${v2Core !== v1Core} pre=${(textOf("bingbing:pre") || "").length}B`,
);

ov.writeOverride({ enabled: false });
check(
  "O4",
  textOf("bingbing:pre") === "" && textOf("bingbing:post") === "" && textOf("bingbing:core") === "",
  `全关：pre=${(textOf("bingbing:pre") || "").length} core=${(textOf("bingbing:core") || "").length} post=${(textOf("bingbing:post") || "").length}`,
);

const asmAllOff = buildAssembly(seen.sections);
const outAllOff = await handler(asmAllOff, {}, async () => asmAllOff);
check(
  "O5",
  outAllOff.contexts.some((c) => c.name === "approval:policy"),
  `全关时不再过滤：approval:policy 保留=${outAllOff.contexts.some((c) => c.name === "approval:policy")}`,
);

ov.clearOverride();
check(
  "O6",
  (textOf("bingbing:pre") || "").length > 0 && (textOf("bingbing:core") || "").length > 0,
  `复位：pre=${(textOf("bingbing:pre") || "").length}B core=${(textOf("bingbing:core") || "").length}B`,
);

// ---- 版本库 / 更新器（U1–U8）----------------------------------------------
const reg = await import("../lib/update/registry.js");
const svc = await import("../lib/update/service.js");
const { assertSafePath } = await import("../lib/update/pack.js");
const { tagToVersion, pickTgz } = await import("../lib/update/github.js");

check("U1", reg.compareVersion("0.10.0", "0.9.0") > 0 && reg.compareVersion("0.9.0", "0.9.1") < 0, "版本比较按数值段：0.10.0 > 0.9.0");

const empty = svc.status();
check("U2", empty.managed === false && empty.versions.length === 0 && empty.active === null, `空版本库：managed=${empty.managed} versions=${empty.versions.length}`);

let threw = false;
try {
  reg.activate("9.9.9");
} catch {
  threw = true;
}
check("U3", threw, "激活不存在的版本必须抛错（不允许把 current 指到空目录）");

let unsafe = 0;
for (const bad of ["../x", "/etc/passwd", "C:/Windows/system32", "a/../../b"]) {
  try {
    assertSafePath(bad);
  } catch {
    unsafe += 1;
  }
}
check("U4", unsafe === 4, `路径穿越拦截 ${unsafe}/4`);

check("U5", tagToVersion("v0.10.0") === "0.10.0" && tagToVersion("release-0.9.0") === "0.9.0", "tag → 版本号归一化");

const fake = { assets: [{ name: "bingbing-0.10.0-portable.zip", size: 1, url: "u" }, { name: "bingbing-0.10.0.tgz", size: 2, url: "v" }] };
check("U6", pickTgz(fake)?.name === "bingbing-0.10.0.tgz", `资产选择：${pickTgz(fake)?.name}`);

// pending 结算：PASS 清 pending，FAIL 自动回滚到 from
for (const ver of ["0.9.0", "0.9.1"]) {
  fs.mkdirSync(reg.versionDir(ver), { recursive: true });
  fs.writeFileSync(path.join(reg.versionDir(ver), "package.json"), JSON.stringify({ name: "bingbing", version: ver }));
}
reg.activate("0.9.0");
reg.activate("0.9.1");
const settledPass = svc.settlePending(() => ({ verdict: "PASS", probes: [{ ok: true }] }));
check("U7", settledPass.action === "confirmed" && reg.readPending() === null, `PASS 结算：action=${settledPass.action} pending=${reg.readPending()}`);

reg.activate("0.9.0");
reg.activate("0.9.1");
const settledFail = svc.settlePending(() => ({ verdict: "FAIL", probes: [{ id: "S4", ok: false }] }));
check(
  "U8",
  settledFail.action === "rolled-back" && reg.activeVersion() === "0.9.0",
  `FAIL 自动回滚：action=${settledFail.action} active=${reg.activeVersion()}`,
);

// ---- 安全硬化（U9–U11）----------------------------------------------------
// U9 版本号当路径用，必须先过白名单（远端 tgz 的 package.json 是第三方内容）
let badVersions = 0;
for (const bad of ["../../evil", "/abs/1.0.0", "1.0.0/../../x", "dev", ""]) {
  try {
    reg.versionDir(bad);
  } catch {
    badVersions += 1;
  }
}
check(
  "U9",
  badVersions === 5 && reg.versionDir("1.2.3") === path.join(reg.versionsDir(), "1.2.3"),
  `版本号白名单挡住 ${badVersions}/5 个异常值，合法值仍可用`,
);

// U10 自动回滚之后 pending 必须清掉（否则面板永久自相矛盾）
for (const ver of ["0.9.2", "0.9.3"]) {
  fs.mkdirSync(reg.versionDir(ver), { recursive: true });
  fs.writeFileSync(path.join(reg.versionDir(ver), "package.json"), JSON.stringify({ name: "bingbing", version: ver }));
}
reg.activate("0.9.2");
reg.activate("0.9.3");
const rolled = svc.settlePending(() => ({ verdict: "FAIL", probes: [{ id: "S4", ok: false }] }));
const markerPath = path.join(HOME, "state", "bingbing", "rollback-needed.json");
check(
  "U10",
  rolled.action === "rolled-back" && reg.readPending() === null && reg.activeVersion() === "0.9.2" && fs.existsSync(markerPath),
  `回滚后 pending 已清：action=${rolled.action} active=${reg.activeVersion()} pending=${JSON.stringify(reg.readPending())}`,
);

// U10b 历史残留的"待确认但不是当前版本"要能自愈，不再 pending-not-active 死循环
fs.writeFileSync(
  path.join(HOME, "state", "bingbing", "pending.json"),
  JSON.stringify({ from: "0.9.2", to: "0.9.3", at: new Date().toISOString(), attempts: 1 }),
);
const healed = svc.settlePending(() => ({ verdict: "PASS", probes: [{ ok: true }] }));
check(
  "U10b",
  healed.reason === "pending-not-active" && healed.cleared === true && reg.readPending() === null,
  `残留 pending 自愈：${JSON.stringify(healed)}`,
);

// U11 结算只认本进程的快照：跨进程快照一律 N/A（否则坏版本会被判 PASS）
const snapPath = path.join(HOME, "state", "bingbing", "last-assembly.json");
fs.writeFileSync(
  snapPath,
  JSON.stringify({
    at: new Date().toISOString(),
    bootId: "another-process",
    enabled: true,
    promptSet: "v1+shell",
    assemblies: 7,
    sections: [],
    contexts: [],
    dropped: [],
    rewritten: [],
  }),
);
const foreign = staticProbes(resolveCore({}), { sameBootId: "this-process" });
const sameBoot = staticProbes(resolveCore({}), { sameBootId: "another-process" });
const audit = staticProbes(resolveCore({}));
check(
  "U11",
  foreign.summary.verdict === "UNKNOWN" && foreign.summary.unknown === 5,
  `跨进程快照不下判断：verdict=${foreign.summary.verdict} unknown=${foreign.summary.unknown}`,
);
check(
  "U11b",
  sameBoot.summary.verdict !== "UNKNOWN" && audit.summary.verdict !== "UNKNOWN",
  `同 bootId / 审计模式仍下判断：own=${sameBoot.summary.verdict} audit=${audit.summary.verdict}`,
);

// ---- 汇总 ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const item of results) {
  if (!item.ok || verbose) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id} — ${item.detail}`);
  }
}
console.log("");
console.log(`selftest: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
console.log(`state dir (临时): ${HOME}`);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结果 */
}

process.exitCode = failed.length === 0 ? 0 : 1;
