#!/usr/bin/env node
/**
 * bingbing 验收器（只读为主；临时文件写在 .tmp/acceptance 下，跑完清理）
 *
 * 用法：node tools/acceptance.mjs
 * 退出码：0 = 全 PASS（WARN 不影响）；1 = 有 FAIL
 *
 * 设计原则：
 * - 每条断言都必须能从磁盘/运行产物独立复核，不信插件自述。
 * - 需要跑子进程时一律用 process.execPath，不依赖 PATH 上有 node。
 * - 不依赖 tar / pnpm / pwsh：tgz 用 zlib + 手写 tar 解析，直接落到临时目录验证。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_HOME = String(process.env.DSH_HOME || "").trim() || path.join(os.homedir(), ".dsh");
const STATE = path.join(DSH_HOME, "state", "bingbing");
const TMP = path.join(ROOT, ".tmp", "acceptance");
const SYSTMP = path.join(TMP, "systmp"); // 给子进程的 TEMP/TMP（必须真实存在）
const PKG = path.join(TMP, "pkg");
fs.mkdirSync(SYSTMP, { recursive: true });

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJson = (fp) => {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
};
const exists = (fp) => {
  try {
    return fs.statSync(fp).isFile();
  } catch {
    return false;
  }
};

const items = [];
const add = (id, name, status, detail) => items.push({ id, name, status, detail });

function nodeRun(args, cwd) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, TEMP: SYSTMP, TMP: SYSTMP },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), err: r.error ? String(r.error.message) : null };
}

/** 极简 tar 解包：够读 npm/pnpm 打出来的 ustar，不处理 PAX 长名。 */
function extractTgz(tgzPath, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const written = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const raw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    off += 512;
    const body = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (!raw || raw.endsWith("/")) continue;
    if (raw.startsWith("package/") === false && raw !== "package") continue;
    const rel = raw.replace(/^package\/?/, "");
    if (!rel) continue;
    const target = path.join(destDir, rel);
    if (!target.startsWith(destDir)) continue;
    if (type !== "0" && type !== "\0") continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    written.push(rel);
  }
  if (!written.length) throw new Error("tgz 内没有可解出的文件");
  return written;
}

// ── A1 运行时 ───────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split(".")[0]);
add("A1", "node >= 18", nodeMajor >= 18 ? "PASS" : "FAIL", `v${process.versions.node}`);

// ── A2 selftest ────────────────────────────────────────────────────────────
const st = nodeRun(["tests/selftest.mjs"], ROOT);
const stMatch = /selftest:\s*(\d+)\/(\d+) passed/.exec(st.out);
const stOk = st.code === 0 && Boolean(stMatch) && stMatch[1] === stMatch[2];
add("A2", "selftest 全绿", stOk ? "PASS" : "FAIL", stMatch ? `${stMatch[1]}/${stMatch[2]}` : st.out.slice(0, 120) || `exit ${st.code}`);

// ── A3 探针 S1–S5 ──────────────────────────────────────────────────────────
const ck = nodeRun(["bin/bingbing.js", "check"], ROOT);
const ckMatch = /verdict:\s*(\w+)/.exec(ck.out);
add("A3", "探针 S1–S5", ckMatch && ckMatch[1] === "PASS" ? "PASS" : "FAIL", ckMatch ? `verdict=${ckMatch[1]}` : ck.out.slice(0, 160) || `exit ${ck.code}`);

// ── A4..A8 从装配快照独立复核 ──────────────────────────────────────────────
const snap = readJson(path.join(STATE, "last-assembly.json"));
if (!snap) {
  for (const id of ["A4", "A5", "A6", "A7", "A8"]) add(id, "装配快照", "FAIL", "last-assembly.json 不存在：宿主未运行或 trace=false");
} else {
  const sections = Array.isArray(snap.sections) ? snap.sections : [];
  const contexts = Array.isArray(snap.contexts) ? snap.contexts : [];
  const names = sections.map((s) => String(s.name));

  const postIdx = names.lastIndexOf("bingbing:post");
  const officialMax = names.reduce((max, n, i) => (n.startsWith("bingbing:") ? max : i), -1);
  add("A4", "post 抢到末位", postIdx >= 0 && postIdx > officialMax ? "PASS" : "FAIL", postIdx >= 0 ? `post@${postIdx} / 官方最大@${officialMax}` : "post 段缺失");

  const ident = names.filter((n) => n.toLowerCase().split(/[^a-z0-9]+/).includes("identity"));
  add("A5", "identity 段已滤除", ident.length === 0 ? "PASS" : "FAIL", ident.length ? ident.join(",") : "无 identity 段");

  // A6 —— 政策上下文已处置。M2 起默认 rewrite：段名本来就该留着，只换文本，
  // 所以判据必须跟着模式走，否则永远 FAIL。
  const OFFICIAL_POLICY = ["approval prompts are disabled", "do not request sandbox escalation", "sandbox escalation", "approval policy", "permission mode", "sandbox mode"];
  const policyByName = contexts.filter((c) => /approval|sandbox|policy|permission/i.test(String(c.name)));
  const policyByText = contexts.filter((c) => {
    const text = String(c.preview ?? "").toLowerCase();
    return OFFICIAL_POLICY.some((needle) => text.includes(needle));
  });
  const policyMode = snap.policyMode === "rewrite" ? "rewrite" : "drop";
  add(
    "A6",
    "政策 contexts 已处置",
    policyMode === "rewrite" ? (policyByText.length === 0 ? "PASS" : "FAIL") : policyByName.length === 0 ? "PASS" : "FAIL",
    policyMode === "rewrite"
      ? `rewrite：保留段名 ${policyByName.length} 段，残留官方政策句 ${policyByText.length}`
      : policyByName.length
        ? policyByName.map((c) => c.name).join(",")
        : "无残留",
  );

  const counts = ["bingbing:pre", "bingbing:core", "bingbing:post"].map((n) => [n, names.filter((x) => x === n).length]);
  const dup = counts.filter(([, c]) => c !== 1);
  add("A7", "三段各恰好一次", dup.length === 0 ? "PASS" : "FAIL", dup.length ? dup.map(([n, c]) => `${n}x${c}`).join(",") : "各 1 次");

  const diskCore = exists(path.join(DSH_HOME, "prompt-inject.md")) ? sha(fs.readFileSync(path.join(DSH_HOME, "prompt-inject.md"))) : "";
  const snapCore = String(snap.core?.sha256 || "");
  const inAsm = snap.core?.inAssembly === true;
  add("A8", "core 正文在装配中且与磁盘一致", inAsm && snapCore && snapCore === diskCore ? "PASS" : "FAIL", `${snapCore.slice(0, 12) || "?"} / 磁盘 ${diskCore.slice(0, 12) || "?"} / ${snap.core?.bytes ?? 0} B`);
}

// ── A9 线上配置与 patch 文件一致 ───────────────────────────────────────────
const status = readJson(path.join(STATE, "status.json"));
const patchPath = path.join(DSH_HOME, "profiles", "desktop", "cordis.patch.yml");
if (!status) {
  add("A9", "配置一致性", "FAIL", "status.json 不存在");
} else {
  let yml = "";
  try {
    yml = fs.readFileSync(patchPath, "utf8");
  } catch {
    yml = "";
  }
  const ySet = (/promptSet:\s*['"]?([^'"\n#]+)/.exec(yml) || [])[1];
  const yOrder = (/promptOrder:\s*['"]?([0-9]+)/.exec(yml) || [])[1];
  const used = status.configUsed || {};
  const ok = (!ySet || ySet.trim() === used.promptSet) && (!yOrder || Number(yOrder) === Number(used.promptOrder));
  add("A9", "线上配置 = patch 文件", ok ? "PASS" : "FAIL", `线上 ${used.promptSet}/${used.promptOrder} ｜ 文件 ${(ySet || "?").trim()}/${yOrder || "?"}`);
}

// ── A10 + A11 对 dist 里的 tgz 实测 ─────────────────────────────────────────
const distDir = path.join(ROOT, "dist");
const tgzName = fs.existsSync(distDir) ? fs.readdirSync(distDir).find((n) => n.endsWith(".tgz")) : null;
if (!tgzName) {
  add("A10", "tgz 存在且可解", "FAIL", "dist/ 下没有 .tgz（先跑 installer\\build.ps1 或 pnpm pack）");
  add("A11", "空 DSH_HOME 回落包内正文", "FAIL", "无 tgz 可验");
} else {
  const tgzPath = path.join(distDir, tgzName);
  const extractDir = path.join(PKG, "package-root");
  try {
    fs.rmSync(PKG, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    const files = extractTgz(tgzPath, extractDir);
    add("A10", "tgz 解包后能加载", "PASS", `${tgzName} ${fs.statSync(tgzPath).size} B / ${files.length} 文件`);
    // 精简包不带 tests/：有就跑自测，没有就退化成"能不能 import 进来"
    if (fs.existsSync(path.join(extractDir, "tests", "selftest.mjs"))) {
      const sub = nodeRun(["tests/selftest.mjs"], extractDir);
      const m = /selftest:\s*(\d+)\/(\d+) passed/.exec(sub.out);
      if (!(sub.code === 0 && m && m[1] === m[2])) {
        const last = items[items.length - 1];
        last.status = "FAIL";
        last.detail += ` ｜ 解包后 selftest ${m ? `${m[1]}/${m[2]}` : "无法解析"}`;
      }
    } else {
      try {
        const mod = await import(pathToFileURL(path.join(extractDir, "lib", "index.js")).href);
        const ok = typeof mod.apply === "function" && typeof mod.status === "function";
        if (!ok) throw new Error("入口缺 apply/status");
        const st = mod.status({});
        if (!st || !st.core || !(st.core.bytes > 0)) throw new Error("status() 拿不到正文");
      } catch (error) {
        const last = items[items.length - 1];
        last.status = "FAIL";
        last.detail += ` ｜ 解包后加载失败：${error.message}`;
      }
    }

    // A11：把 DSH_HOME 指到空目录，让 resolveV1 必须回落包内
    const saved = process.env.DSH_HOME;
    const emptyHome = path.join(TMP, "emptyhome");
    fs.mkdirSync(emptyHome, { recursive: true });
    process.env.DSH_HOME = emptyHome;
    try {
      const mod = await import(pathToFileURL(path.join(extractDir, "lib", "l0", "prompt.js")).href);
      const v1 = mod.resolveV1();
      const ok = v1.role === "bundled" && v1.bytes > 20000;
      add("A11", "空 DSH_HOME 回落包内正文", ok ? "PASS" : "FAIL", `role=${v1.role} / ${v1.bytes} B`);
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  } catch (e) {
    add("A10", "tgz 解包后 selftest 全绿", "FAIL", String(e && e.message));
    add("A11", "空 DSH_HOME 回落包内正文", "FAIL", "解包失败，无法验证");  }
}

// ── A12 客户端插件契约（按钮能不能出现，先看契约对不对）─────────────────
const client = nodeRun(["tools/check-client.mjs"], ROOT);
const clientVerdict = /verdict:\s*(PASS|FAIL)/.exec(client.out);
add(
  "A12",
  "client 插件契约",
  client.code === 0 && clientVerdict && clientVerdict[1] === "PASS" ? "PASS" : "FAIL",
  clientVerdict ? `verdict=${clientVerdict[1]}` : client.out.slice(0, 160) || `exit ${client.code}`,
);

// ── A13 结构对等（M2）：政策段应当被改写而不是删除 ───────────────────────
// 判据只能从快照里取。旧代码写的快照没有 policyMode 字段，此时报 WARN（不是缺陷，
// 是运行中的插件还没重载），重启后再跑就应当 PASS。
if (!snap) {
  add("A13", "政策段结构对等", "WARN", "尚无装配快照，重启宿主并发一句话后重跑");
} else if (!Object.prototype.hasOwnProperty.call(snap, "policyMode")) {
  add("A13", "政策段结构对等", "WARN", "运行中的是旧代码（快照无 policyMode 字段），重启宿主后生效");
} else {
  const mode = snap.policyMode === "drop" ? "drop" : "rewrite";
  const inCount = Number.isFinite(snap.contextsIn) ? snap.contextsIn : null;
  const outCount = Number.isFinite(snap.contextsOut) ? snap.contextsOut : (snap.contexts || []).length;
  const rewritten = Array.isArray(snap.rewritten) ? snap.rewritten.length : 0;
  const ok = mode === "drop" ? true : snap.structureParity === true && outCount === inCount;
  add(
    "A13",
    "政策段结构对等",
    ok ? "PASS" : "FAIL",
    mode === "drop"
      ? "drop 模式（旧行为，按配置跳过结构对等检查）"
      : `mode=rewrite contexts 入${inCount}/出${outCount} 改写${rewritten}条 parity=${snap.structureParity}`,
  );
}

// ── W1 快照新鲜度（bug #14 的可见症状）────────────────────────────────────
if (snap) {
  const postOnDisk = path.join(ROOT, "prompts", "shell", "post.md");
  const postInSnap = (snap.sections || []).find((s) => s.name === "bingbing:post") || {};
  if (exists(postOnDisk)) {
    const a = sha(fs.readFileSync(postOnDisk));
    const b = String(postInSnap.sha256 || "");
    // 注意：status.json 是 apply() 落盘的，里面只有 `at`（apply 时刻），
    // 没有 `lastApply`（那是 status() 工具输出的字段）。用错会得到 NaN，
    // 于是 WARN 分支永远进不去、一律掉到 FAIL。
    const applyAt = Date.parse((status && status.at) || "");
    const snapAt = Date.parse(snap.at || "");
    // 刚重启的进程一次都还没组装过 → 快照必然是本进程启动前的旧文件。
    // 这不是缺陷，是时序：先在 GUI 里发一句话触发一次组装。
    const notYetAssembled = Number.isFinite(applyAt) && (!Number.isFinite(snapAt) || snapAt < applyAt);
    const hhmmss = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : "?");
    if (a === b) {
      add("W1", "快照反映当前 post 内容", "PASS", "一致");
    } else if (notYetAssembled) {
      add(
        "W1",
        "快照反映当前 post 内容",
        "WARN",
        `本进程尚未组装过（apply ${hhmmss(applyAt)} > 快照 ${hhmmss(snapAt)}）：在 GUI 里发任意一句话后重跑`,
      );
    } else {
      add(
        "W1",
        "快照反映当前 post 内容",
        "FAIL",
        `快照 ${b.slice(0, 12)} / 磁盘 ${a.slice(0, 12)}：本进程已组装过却仍是旧内容 → 加载的不是当前代码，需重载`,
      );
    }
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const fails = items.filter((i) => i.status === "FAIL");
const warns = items.filter((i) => i.status === "WARN");
const width = Math.max(...items.map((i) => i.name.length), 10);
console.log("");
console.log(`bingbing acceptance — ${readJson(path.join(ROOT, "package.json"))?.version ?? "?"}  (${DSH_HOME})`);
console.log("─".repeat(78));
for (const i of items) {
  console.log(`[${i.id}] ${i.name.padEnd(width)}  ${i.status.padEnd(4)}  ${i.detail}`);
}
console.log("─".repeat(78));
console.log(`verdict: ${fails.length ? "FAIL" : "PASS"}  (${items.length - fails.length - warns.length}/${items.length} PASS, ${warns.length} WARN, ${fails.length} FAIL)`);
console.log("");

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

process.exitCode = fails.length ? 1 : 0;
