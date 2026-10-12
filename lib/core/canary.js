import path from "node:path";
import { readJson, sha256, stateRoot } from "./state.js";

const OUR_PREFIX = "bingbing:";
const EXPECTED_SHELL = [`${OUR_PREFIX}pre`, `${OUR_PREFIX}core`, `${OUR_PREFIX}post`];
const EXPECTED_BARE = [`${OUR_PREFIX}core`];

const LABELS = {
  S1: "政策上下文已处置（删除或改写）",
  S2: "无官方身份段",
  S3: "post 段位于尾部",
  S4: "核心正文已进入本次组装",
  S5: "三段各恰好一次",
};

const POLICY_TEXT = [
  "approval prompts are disabled",
  "do not request sandbox escalation",
  "sandbox escalation",
  "approval policy",
  "permission mode",
  "sandbox mode",
];

function tokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** 政策名字：approval 或 sandbox 前缀也算（approvals、sandboxed）。 */
function policyName(name) {
  return tokens(name).some(
    (word) => word === "policy" || word === "permission" || word.startsWith("approval") || word.startsWith("sandbox"),
  );
}

function policyText(sample) {
  const lower = String(sample ?? "").toLowerCase();
  return POLICY_TEXT.some((needle) => lower.includes(needle));
}

export function summarize(probes) {
  const pass = probes.filter((p) => p.ok === true).length;
  const fail = probes.filter((p) => p.ok === false).length;
  const unknown = probes.filter((p) => p.ok === null || p.ok === undefined).length;
  return {
    total: probes.length,
    pass,
    fail,
    unknown,
    verdict: fail > 0 ? "FAIL" : unknown > 0 ? "UNKNOWN" : "PASS",
  };
}

/**
 * 静态探针：读 waterfall 落盘的 last-assembly.json，断言机制态。
 * 不发模型调用，不发网络请求。
 */
export function staticProbes(core) {
  const probesFile = path.join(stateRoot(), "last-assembly.json");
  const last = readJson(probesFile, null);
  const probes = [];
  const add = (id, ok, detail) => probes.push({ id, name: LABELS[id], ok, detail });

  if (!last) {
    for (const id of Object.keys(LABELS)) add(id, null, "尚无 assemble 记录：重启宿主并新建会话后产生");
    return { available: false, at: null, probesFile, probes, summary: summarize(probes) };
  }

  // 越狱被主动关掉时，过滤本来就不该发生：报 N/A，不报 FAIL（那是预期，不是缺陷）。
  if (last.enabled === false) {
    for (const id of Object.keys(LABELS)) add(id, null, "越狱已关闭（override enabled=false）：探针不适用");
    return {
      available: true,
      off: true,
      at: last.at ?? null,
      promptSet: last.promptSet ?? null,
      assemblies: last.assemblies ?? null,
      probesFile,
      probes,
      summary: summarize(probes),
    };
  }

  const sections = Array.isArray(last.sections) ? last.sections : [];
  const contexts = Array.isArray(last.contexts) ? last.contexts : [];
  const dropped = Array.isArray(last.dropped) ? last.dropped : [];
  const shell = last.promptSet !== "v1";

  // S1 —— 独立复核：留下的上下文不能再携带官方政策句。
  //
  // M2 起默认是 rewrite：段名与位置保留（结构对等），只把文本换成"已授权"版本。
  // 所以这里不能再用"政策名字是否存在"判定——名字本来就该留着；
  // 判据改成"文本里是否还残留官方政策句"，并单独报出改写条数。
  if (last.filterPolicyContexts === false) {
    add("S1", null, "filterPolicyContexts=false：按配置不过滤");
  } else {
    const rewritten = Array.isArray(last.rewritten) ? last.rewritten : [];
    const official = contexts.filter((entry) => policyText(entry.preview));
    const leftover = contexts.filter((entry) => policyName(entry.name) || policyText(entry.preview));
    const mode = last.policyMode === "drop" ? "drop" : "rewrite";
    add(
      "S1",
      official.length === 0,
      mode === "drop"
        ? `已删除 ${dropped.length} 条；残留 ${leftover.length ? leftover.map((entry) => entry.name).join(", ") : "无"}（assembly 层）`
        : `已改写 ${rewritten.length} 条（段名保留）；仍含官方政策句 ${official.length ? official.map((entry) => entry.name).join(", ") : "无"}（assembly 层）`,
    );
  }

  // S2 —— identity 段不该出现在最终 assembly 里
  const identity = sections.filter((section) => tokens(section.name).includes("identity"));
  if (last.filterIdentitySections === false) {
    add("S2", null, "filterIdentitySections=false：按配置不过滤");
  } else {
    add("S2", identity.length === 0, identity.length ? `仍存在 ${identity.map((s) => s.name).join(", ")}` : "无 identity 段");
  }

  // S3 —— post 必须排在所有官方段之后。
  // 注意：宿主 AssembledSection 只有 {name,text}，没有 order 字段（实测：order 全为 null），
  // 所以这里用**数组位置**判断，不能用 order 数值。
  if (!shell) {
    add("S3", null, "promptSet=v1：不注册 post 段（预期，非缺陷）");
  } else {
    const names = sections.map((section) => String(section.name));
    const postIndex = names.lastIndexOf(`${OUR_PREFIX}post`);
    const officialIndexes = sections
      .map((section, index) => ({ section, index }))
      .filter((item) => !String(item.section.name).startsWith(OUR_PREFIX))
      .map((item) => item.index);
    const officialMaxIndex = officialIndexes.length ? Math.max(...officialIndexes) : -1;
    add(
      "S3",
      postIndex >= 0 && postIndex > officialMaxIndex,
      postIndex >= 0
        ? `post@${postIndex} / 官方最大@${officialMaxIndex}`
        : "post 段未注册（检查 prompts/shell/post.md）",
    );
  }

  // S4 —— 核心段必须真的出现在 assembly 里，且与当前解析结果一致
  const current = sha256(core?.text ?? "");
  const recorded = String(last.core?.sha256 ?? "");
  const inAssembly = last.core?.inAssembly === true;
  add(
    "S4",
    inAssembly && Boolean(recorded) && recorded === current && (core?.bytes ?? 0) > 0,
    inAssembly
      ? `组装时 ${recorded.slice(0, 12) || "?"} / 现在 ${current.slice(0, 12)} / ${core?.bytes ?? 0} B`
      : "bingbing:core 未出现在 assembly（段注册失败或 enabled=false）",
  );

  // S5 —— 我们的段各恰好一次（双注册 / 新旧并存会暴露）
  const expected = shell ? EXPECTED_SHELL : EXPECTED_BARE;
  const counts = expected.map((name) => ({ name, count: sections.filter((section) => section.name === name).length }));
  const bad = counts.filter((entry) => entry.count !== 1);
  const foreignOnly =
    last.singleSection === true && !String(last.singleSectionName ?? "").startsWith(OUR_PREFIX);
  if (foreignOnly) {
    add(
      "S5",
      null,
      `疑似 complete 段生效（唯一段=${last.singleSectionName}）：waterfall 快照无法证明最终 prompt，需看会话实际首段`,
    );
  } else {
    add("S5", bad.length === 0, bad.length ? bad.map((entry) => `${entry.name}x${entry.count}`).join(", ") : "各 1 次");
  }

  return {
    available: true,
    at: last.at ?? null,
    promptSet: last.promptSet ?? null,
    assemblies: last.assemblies ?? null,
    probesFile,
    probes,
    summary: summarize(probes),
  };
}
