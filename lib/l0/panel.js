import path from "node:path";
import fs from "node:fs";
import { effectiveConfig, normalizeConfig, readPostTail, readShell, resolveCore } from "./prompt.js";
import { appendSwitchLog, clearOverride, overridePath, readOverride, readSwitchLog, writeOverride } from "./override.js";
import { staticProbes } from "../core/canary.js";
import { dshHome, readJson, sha256, stateRoot } from "../core/state.js";

/** 界面要显示版本号：读一次包清单，读不到就报 "?"（不允许因此抛错）。 */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "?";
  }
})();

/**
 * 开关台的共享后端：宿主内路由（lib/index.js）与独立服务（bin/bingbing-ui.mjs）
 * 都调这里，避免两套判断逻辑漂移。
 */

/** 预设：把"旧越狱 / 新越狱 / 机制内核 / 关闭"落成具体配置。 */
export const PRESETS = {
  legacy: { enabled: true, promptSet: "v1+shell", tail: "legacy" },
  current: { enabled: true, promptSet: "v1+shell", tail: "current" },
  kernel: { enabled: true, promptSet: "v2", tail: "current" },
  off: { enabled: false, promptSet: "v1+shell", tail: "current" },
};

// 标签里的字节数必须现算：尾段会被改（加了范围规则后从 1757 → 2787），
// 写死就会像这次一样在面板和 `which` 里报旧数字。
const tailSize = (variant) => {
  try {
    return readPostTail(variant).bytes;
  } catch {
    return 0;
  }
};

const PRESET_LABELS = {
  legacy: `旧越狱（正文 + ${tailSize("legacy")} B 旧尾段）`,
  current: `当前越狱（正文 + ${tailSize("current")} B 机制尾段）`,
  kernel: "机制内核（v2 正文 + 机制尾段）",
  off: "关闭（三段清空，不做过滤）",
};

export const EMPTY = { bytes: 0, sha256: sha256("") };
const stamp = (text) => ({ bytes: Buffer.byteLength(text || "", "utf8"), sha256: sha256(text || "") });

export function snapshotPath() {
  return path.join(stateRoot(), "last-assembly.json");
}

export function baseConfig() {
  const status = readJson(path.join(stateRoot(), "status.json"), null);
  return normalizeConfig(status && status.configUsed ? status.configUsed : {});
}

/** 当前生效配置下，三段**应该**长什么样。 */
export function expectedFor(eff) {
  if (!eff.enabled) {
    return { core: EMPTY, pre: EMPTY, post: EMPTY, note: "已关闭：三段都不贡献内容，waterfall 也不过滤政策上下文" };
  }
  const core = resolveCore(eff);
  const withShell = eff.promptSet !== "v1";
  return {
    core: { bytes: core.bytes, sha256: core.sha256 },
    pre: withShell ? stamp(readShell("pre").text) : EMPTY,
    post: withShell ? stamp(readPostTail(eff.tail).text) : EMPTY,
    note:
      eff.promptSet === "v2"
        ? "v2：机制内核 + pre + 尾段"
        : eff.promptSet === "v1"
          ? "v1：只投递正文，pre/post 不贡献内容"
          : `v1+shell：正文 + pre + ${eff.tail === "legacy" ? "旧" : "机制"}尾段`,
  };
}

function sectionIn(snapshot, name) {
  const hit = (snapshot?.sections || []).find((s) => s.name === name);
  return hit ? { bytes: hit.bytes, sha256: hit.sha256 } : null;
}

const same = (a, b) => Boolean(a && b) && a.bytes === b.bytes && a.sha256 === b.sha256;

function activePreset(eff) {
  if (!eff.enabled) return "off";
  if (eff.promptSet === "v2") return "kernel";
  return eff.tail === "legacy" ? "legacy" : "current";
}

export function buildState() {
  const base = baseConfig();
  const eff = effectiveConfig(base);
  const override = readOverride();
  const snapshot = readJson(snapshotPath(), null);
  const log = readSwitchLog(20);
  const expected = expectedFor(eff);

  const actual = {
    pre: sectionIn(snapshot, "bingbing:pre"),
    core: sectionIn(snapshot, "bingbing:core"),
    post: sectionIn(snapshot, "bingbing:post"),
  };

  const lastSwitch = log[0] || null;
  const snapAt = snapshot?.at ? Date.parse(snapshot.at) : NaN;
  const switchAt = lastSwitch?.at ? Date.parse(lastSwitch.at) : NaN;

  const rows = [
    { part: "pre", label: "前段 pre", expected: expected.pre, actual: actual.pre, ok: same(expected.pre, actual.pre) },
    { part: "core", label: "正文 core", expected: expected.core, actual: actual.core, ok: same(expected.core, actual.core) },
    { part: "post", label: "尾段 post", expected: expected.post, actual: actual.post, ok: same(expected.post, actual.post) },
  ];

  const droppedNames = (snapshot?.dropped || []).map((d) => d.name).sort();
  const rewrittenNames = (snapshot?.rewritten || []).map((r) => r.name).sort();
  const policyWanted = eff.enabled && eff.filterPolicyContexts;
  const policyMode = eff.policyMode === "drop" ? "drop" : "rewrite";
  // 政策行必须按模式判定：rewrite 下"没丢弃"是正常，判据要换成
  // ①有改写记录 ②留下的上下文不再含官方政策句。
  const OFFICIAL = ["approval prompts are disabled", "do not request sandbox escalation", "sandbox escalation", "approval policy", "permission mode", "sandbox mode"];
  const officialLeft = (snapshot?.contexts || []).filter((entry) => {
    const text = String(entry.preview ?? "").toLowerCase();
    return OFFICIAL.some((needle) => text.includes(needle));
  });
  const policyOk = !policyWanted
    ? droppedNames.length === 0 && rewrittenNames.length === 0
    : policyMode === "drop"
      ? droppedNames.length > 0
      : rewrittenNames.length > 0 && officialLeft.length === 0;
  rows.push({
    part: "policy",
    label: policyMode === "drop" ? "政策句删除" : "政策句改写",
    expected: { bytes: policyWanted ? 1 : 0, sha256: String(policyWanted) },
    actual: {
      bytes: policyMode === "drop" ? droppedNames.length : rewrittenNames.length,
      sha256: policyMode === "drop" ? droppedNames.join(",") || "(未丢弃)" : rewrittenNames.join(",") || "(未改写)",
    },
    ok: policyOk,
    textual: true,
    expectedText: !policyWanted
      ? "不应处置（已关闭或停用过滤）"
      : policyMode === "drop"
        ? "应删除 sandbox:policy / approval:policy"
        : "应改写 sandbox:policy / approval:policy（保留段名，文本不含官方政策句）",
    actualText: !policyWanted
      ? `${droppedNames.length + rewrittenNames.length} 条被处置`
      : policyMode === "drop"
        ? droppedNames.length
          ? `已删除 ${droppedNames.join(", ")}`
          : "未丢弃任何 context"
        : rewrittenNames.length
          ? `已改写 ${rewrittenNames.join(", ")}${officialLeft.length ? `；残留官方句 ${officialLeft.map((e) => e.name).join(", ")}` : ""}`
          : "未改写任何 context",
  });

  const allOk = rows.every((r) => r.ok);
  const matched = Boolean(snapshot) && allOk;
  const pending = !matched && Number.isFinite(switchAt) && (!Number.isFinite(snapAt) || snapAt < switchAt);

  // 判据：新版 assemble.js 才会把 enabled 写进快照；旧版没有这个字段。
  const overrideSupported = snapshot ? Object.prototype.hasOwnProperty.call(snapshot, "enabled") : null;
  const codeStale = Boolean(override) && overrideSupported === false;

  return {
    at: new Date().toISOString(),
    version: PKG_VERSION,
    paths: { dshHome: dshHome(), state: stateRoot(), override: overridePath(), snapshot: snapshotPath() },
    base,
    override,
    effective: eff,
    preset: activePreset(eff),
    presets: Object.entries(PRESETS).map(([id, config]) => ({ id, label: PRESET_LABELS[id], config })),
    expected,
    actual,
    rows,
    snapshot: snapshot
      ? {
          at: snapshot.at,
          enabled: snapshot.enabled !== false,
          promptSet: snapshot.promptSet ?? null,
          sections: (snapshot.sections || []).length,
          dropped: droppedNames,
          assemblies: snapshot.assemblies ?? null,
        }
      : null,
    evidence: {
      matched,
      pending,
      codeStale,
      overrideSupported,
      snapshotAt: snapshot?.at ?? null,
      lastSwitchAt: lastSwitch?.at ?? null,
      summary: !snapshot
        ? "尚无装配快照：宿主未运行过，或 trace=false"
        : codeStale
          ? "运行中的插件是旧版代码（快照缺 enabled 字段）：覆盖层写进去了但不会生效，需重启宿主一次"
          : matched
            ? "已生效：快照与期望逐项一致"
            : pending
              ? "已切换，等待下一次组装（在 GUI 里发任意一句话即触发）"
              : "不一致：快照已组装过但仍与期望不符，检查加载的代码/配置",
    },
    log,
    probes: staticProbes(resolveCore(eff)),
  };
}

/** 合法键与取值校验；返回规范化后的 patch，非法则抛出。 */
export function normalizePatch(input) {
  const raw = input && typeof input === "object" ? input : {};
  const patch = {};
  if (raw.preset !== undefined) {
    const preset = PRESETS[String(raw.preset)];
    if (!preset) throw new Error(`未知预设：${raw.preset}（可选 ${Object.keys(PRESETS).join(" / ")}）`);
    return { ...preset };
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    patch.enabled = raw.enabled;
  }
  if (raw.promptSet !== undefined) {
    if (!["v1", "v1+shell", "v2"].includes(String(raw.promptSet))) throw new Error("promptSet 只能是 v1 / v1+shell / v2");
    patch.promptSet = String(raw.promptSet);
  }
  if (raw.tail !== undefined) {
    if (!["current", "legacy"].includes(String(raw.tail))) throw new Error("tail 只能是 current / legacy");
    patch.tail = String(raw.tail);
  }
  if (!Object.keys(patch).length) throw new Error("没有任何有效字段（preset / enabled / promptSet / tail）");
  return patch;
}

/** 应用一次切换：写 override + 记日志，返回切换前后的生效配置。 */
export function applySwitch(input) {
  const patch = normalizePatch(input);
  const before = effectiveConfig(baseConfig());
  const next = writeOverride(patch);
  const after = effectiveConfig(baseConfig());
  appendSwitchLog({
    at: new Date().toISOString(),
    from: { enabled: before.enabled, promptSet: before.promptSet, tail: before.tail },
    patch,
    after: { enabled: after.enabled, promptSet: after.promptSet, tail: after.tail },
    overrideAfter: next,
    via: "panel",
  });
  return { patch, before, after, override: next };
}

/** 清除覆盖，回到 cordis.patch.yml 的静态配置。 */
export function applyReset() {
  const before = effectiveConfig(baseConfig());
  clearOverride();
  const after = effectiveConfig(baseConfig());
  appendSwitchLog({
    at: new Date().toISOString(),
    from: { enabled: before.enabled, promptSet: before.promptSet, tail: before.tail },
    patch: { reset: true },
    after: { enabled: after.enabled, promptSet: after.promptSet, tail: after.tail },
    via: "panel",
  });
  return { before, after };
}
