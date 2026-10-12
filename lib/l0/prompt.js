import path from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome, readText, sha256 } from "../core/state.js";
import { readOverride } from "./override.js";

export const PROMPT_SETS = ["v1", "v1+shell", "v2"];
export const TAIL_VARIANTS = ["current", "legacy"];
export const DEFAULT_PROMPT_ORDER = 5100;

/** 包根目录（本文件在 <pkg>/lib/l0/ 下）。 */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 配置归一化：字符串写错的布尔值（"false"/"0"）不当作真值，
 * 未知键忽略，缺省值在这里兜住。
 */
export function normalizeConfig(config = {}) {
  const raw = config && typeof config === "object" ? config : {};
  const bool = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["false", "0", "no", "off", ""].includes(text)) return false;
    if (["true", "1", "yes", "on"].includes(text)) return true;
    return fallback;
  };
  const promptSet = PROMPT_SETS.includes(String(raw.promptSet ?? "").trim())
    ? String(raw.promptSet).trim()
    : "v1+shell";
  return {
    enabled: bool(raw.enabled, true),
    promptSet,
    // 尾段变体：current = 1757 B 机制内核；legacy = 376 B 旧尾段。两套都随包，可运行时切。
    tail: TAIL_VARIANTS.includes(String(raw.tail ?? "").trim()) ? String(raw.tail).trim() : "current",
    promptOrder: Number.isFinite(raw.promptOrder) ? Number(raw.promptOrder) : DEFAULT_PROMPT_ORDER,
    promptFile: String(raw.promptFile ?? "").trim(),
    filterPolicyContexts: bool(raw.filterPolicyContexts, true),
    filterIdentitySections: bool(raw.filterIdentitySections, true),
    // M2：政策上下文怎么处置。rewrite = 保留段名与位置、只换文本（结构对等）；
    // drop = 旧行为（整段删除，留结构性缺口）。默认 rewrite。
    policyMode: String(raw.policyMode ?? "").trim() === "drop" ? "drop" : "rewrite",
    // M4：把运行契约寄生进 bingbing_status 的工具描述（工具表每轮重建、不受压缩影响）。
    toolContract: bool(raw.toolContract, true),
    trace: bool(raw.trace, true),
    // 更新通道：只放"仓库 + 是否自动检查"。token 不进配置（会写进 status.json），
    // 走环境变量 BINGBING_UPDATE_TOKEN / GITHUB_TOKEN 或 state/bingbing/github-token.txt。
    update: {
      repo: String(raw.update?.repo ?? "").trim(),
      autoCheck: bool(raw.update?.autoCheck, true),
    },
  };
}

/**
 * 生效配置 = 静态配置（apply 时注入）叠加运行时 override.json。
 *
 * 每次组装都会重新算一遍，所以切换 promptSet / enabled 是**下一轮组装生效**，
 * 不需要重启宿主，也不需要重装插件。
 */
export function effectiveConfig(config = {}) {
  const base = normalizeConfig(config);
  const ov = readOverride();
  if (!ov) return base;
  const out = { ...base };
  if (typeof ov.enabled === "boolean") out.enabled = ov.enabled;
  if (PROMPT_SETS.includes(String(ov.promptSet ?? "").trim())) out.promptSet = String(ov.promptSet).trim();
  if (TAIL_VARIANTS.includes(String(ov.tail ?? "").trim())) out.tail = String(ov.tail).trim();
  if (typeof ov.filterPolicyContexts === "boolean") out.filterPolicyContexts = ov.filterPolicyContexts;
  if (typeof ov.filterIdentitySections === "boolean") out.filterIdentitySections = ov.filterIdentitySections;
  if (["rewrite", "drop"].includes(String(ov.policyMode ?? "").trim())) out.policyMode = String(ov.policyMode).trim();
  if (typeof ov.toolContract === "boolean") out.toolContract = ov.toolContract;
  return out;
}

function load(fp, role) {
  const text = readText(fp);
  if (text == null) return null;
  return { fp, role, text, bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) };
}

function missing(fp, detail) {
  return { fp, role: "missing", text: "", bytes: 0, sha256: "", missing: detail ?? fp };
}

/** 现行正文：$DSH_HOME/prompt-inject.md > 随包 prompts/v1/prompt-inject.md */
export function resolveV1() {
  const user = path.join(dshHome(), "prompt-inject.md");
  const userHit = load(user, "user");
  if (userHit) return userHit;

  const bundled = path.join(PACKAGE_ROOT, "prompts", "v1", "prompt-inject.md");
  const bundledHit = load(bundled, "bundled");
  if (bundledHit) return bundledHit;

  return missing(bundled, `user:${user} bundled:${bundled}`);
}

/**
 * 解析核心段正文。
 * 优先级：config.promptFile > (v2 时的 prompts/v2/core.md) > 现行正文
 * v2 缺失 / 正文缺失都记进 degraded，绝不"成功注册空核心段"。
 */
export function resolveCore(config = {}) {
  const cfg = effectiveConfig(config);

  if (cfg.promptFile) {
    const hit = load(cfg.promptFile, "custom");
    if (hit) return { ...hit, set: cfg.promptSet, degraded: null };
    return { ...missing(cfg.promptFile, "promptFile"), set: cfg.promptSet, degraded: "prompt-file-missing" };
  }

  if (cfg.promptSet === "v2") {
    const hit = load(path.join(PACKAGE_ROOT, "prompts", "v2", "core.md"), "v2");
    if (hit) return { ...hit, set: "v2", degraded: null };
    const fallback = resolveV1();
    return { ...fallback, set: "v1+shell", degraded: "v2-core-missing" };
  }

  const core = resolveV1();
  return { ...core, set: cfg.promptSet, degraded: core.role === "missing" ? "core-missing" : null };
}

/** 包装段：prompts/shell/{pre,post}.md */
export function readShell(name) {
  const fp = path.join(PACKAGE_ROOT, "prompts", "shell", `${name}.md`);
  return load(fp, `shell:${name}`) || missing(fp, `shell:${name}`);
}

/**
 * 尾段变体：两套尾段都随包，运行时按 override.tail 选。
 *   current → prompts/shell/post.md（1757 B，机制内核）
 *   legacy  → prompts/shell/post.legacy.md（376 B，旧尾段）
 */
export function readPostTail(variant = "current") {
  const file = variant === "legacy" ? "post.legacy.md" : "post.md";
  const fp = path.join(PACKAGE_ROOT, "prompts", "shell", file);
  return load(fp, `shell:post:${variant === "legacy" ? "legacy" : "current"}`) || missing(fp, `shell:post:${variant}`);
}
