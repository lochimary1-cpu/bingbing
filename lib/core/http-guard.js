/**
 * 本地面板的请求闸门。
 *
 * 面板只绑 127.0.0.1，但"只绑回环"挡不住浏览器：任意网页都能对
 * http://127.0.0.1:7312 发简单请求（text/plain 不触发预检），旧代码还回了
 * access-control-allow-origin: *，等于把开关（以及 /update/install）交给任何
 * 一个开着标签页的站点。
 *
 * 判据只有一条：**Origin 必须是回环**。
 *  - 没有 Origin（curl / node / CLI / 同源 GET）→ 放行，那是用户自己的进程
 *  - Origin 是 http://127.0.0.1 | localhost | [::1] 的任意端口 → 放行并回显
 *  - 其它一律拒绝（含 Origin: null，即 file:// 与沙箱 iframe）
 *
 * 返回值只用于日志，不参与鉴权强度承诺：真正的边界是"浏览器不许跨站写"。
 */

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** 额外允许的 origin（逗号分隔），给"GUI 绑在局域网 IP 上"这类部署留口子。 */
function extraOrigins() {
  return String(process.env.BINGBING_PANEL_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function originAllowed(origin) {
  const value = String(origin ?? "").trim();
  if (!value) return true;
  if (LOOPBACK.test(value)) return true;
  return extraOrigins().includes(value);
}

/** 只回显被允许的 origin；绝不写 `*`（写了就等于把响应交给所有站点读）。 */
export function applyCors(res, origin) {
  const value = String(origin ?? "").trim();
  if (!value || !originAllowed(value)) return;
  res.setHeader("access-control-allow-origin", value);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
}

/**
 * 请求闸门。返回 null 表示放行，返回字符串表示拒绝原因。
 * 两个服务器（宿主内面板、独立网页版）共用，避免两边判据漂移。
 */
export function rejectReason(req) {
  const origin = String(req.headers?.origin ?? "").trim();
  if (origin && !originAllowed(origin)) return `拒绝跨站请求：Origin ${origin}`;
  const site = String(req.headers?.["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site") return "拒绝跨站请求：Sec-Fetch-Site: cross-site";
  return null;
}
