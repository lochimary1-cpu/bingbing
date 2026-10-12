import { effectiveConfig, readPostTail, readShell } from "./prompt.js";
import { DEFAULT_PROMPT_ORDER } from "./prompt.js";

export const SECTIONS = {
  pre: "bingbing:pre",
  core: "bingbing:core",
  post: "bingbing:post",
};

/** 安全判定：cordis 的受控属性访问在未 inject 的 ctx 上会抛错，必须包在 try 里。 */
function hasSection(value) {
  try {
    return Boolean(value) && typeof value.section === "function";
  } catch {
    return false;
  }
}

/**
 * 找出提供 section() / getSectionOrder() 的 systemPrompt 服务。
 *
 * 顺序很重要：先试**自己 ctx 上的** systemPrompt（apply 已声明 inject，
 * 这是唯一保证可访问的路径）；`ctx.systemPrompt.ctx` 是别人 scope 的 ctx，
 * 直接读它的 .systemPrompt.section 会抛 "cannot get property section without inject"。
 */
export function resolveService(ctx) {
  try {
    const direct = ctx?.systemPrompt;
    if (hasSection(direct)) return direct;
  } catch {
    /* ignore */
  }

  try {
    const nested = ctx?.systemPrompt?.ctx;
    if (nested && hasSection(nested.systemPrompt)) return nested.systemPrompt;
  } catch {
    /* ignore */
  }

  try {
    const fetched = typeof ctx?.get === "function" ? ctx.get("systemPrompt") : null;
    if (hasSection(fetched)) return fetched;
  } catch {
    /* ignore */
  }

  if (hasSection(ctx)) return ctx;
  return null;
}

/** order 用语义名推导，不写死数字。 */
export function orderOf(service, name, fallback) {
  try {
    const value = service?.getSectionOrder?.(name);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function sectionOrders(service, config = {}) {
  const core = Number.isFinite(config?.promptOrder) ? Number(config.promptOrder) : DEFAULT_PROMPT_ORDER;
  return {
    pre: orderOf(service, "DEPLOYMENT_PERSONA_PREFIX", 0) + 1,
    core,
    post: orderOf(service, "DEPLOYMENT_PERSONA_SUFFIX", 10200) + 1,
  };
}

/** 注册三段。**三段始终注册**，内容由 thunk 每次组装按 effectiveConfig 决定。
 *
 * 为什么不再按 promptSet 决定注册哪几段：UI 要在运行时把
 * v1 ↔ v1+shell ↔ v2 ↔ 全关 互相切换，而段的注册只发生在 apply() 一次。
 * 注册全量 + thunk 现读，才能做到"切完下一轮生效、不重启"。
 *
 * 正文一律用 thunk 现读：宿主对 section.text 的调用发生在 assemble() 里，
 * 所以改 prompt-inject.md / pre.md / post.md 下一轮就生效。
 */
export function registerSections(service, config, getCore) {
  const orders = sectionOrders(service, config);
  const out = { registered: [], skipped: [], orders, errors: [], disposers: [] };

  const add = (name, order, text) => {
    try {
      const disposer = service.section({
        name,
        order,
        interpolate: false,
        text: typeof text === "function" ? text : () => String(text ?? ""),
      });
      out.registered.push(name);
      if (typeof disposer === "function") out.disposers.push(disposer);
    } catch (e) {
      out.errors.push(`${name}: ${String((e && e.message) || e)}`);
    }
  };

  /** 包装段：关闭或 v1 时返回空串（段还在，只是不贡献内容）。 */
  const shellText = (name) => () => {
    const eff = effectiveConfig(config);
    if (!eff.enabled || eff.promptSet === "v1") return "";
    return readShell(name).text || "";
  };

  /** 尾段按变体现读：current（1757 B）/ legacy（376 B）。 */
  const postText = () => {
    const eff = effectiveConfig(config);
    if (!eff.enabled || eff.promptSet === "v1") return "";
    return readPostTail(eff.tail).text || "";
  };

  add(SECTIONS.pre, orders.pre, shellText("pre"));
  add(SECTIONS.post, orders.post, postText);
  add(SECTIONS.core, orders.core, () => {
    const eff = effectiveConfig(config);
    if (!eff.enabled) return "";
    return (typeof getCore === "function" ? getCore(eff).text : getCore?.text) || "";
  });
  return out;
}
