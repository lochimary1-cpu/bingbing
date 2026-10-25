import { check, install, rollback, status, switchTo, writeRestartScript } from "./service.js";
import { removeVersion } from "./registry.js";

/**
 * 更新相关的面板路由。
 *
 * 与 /state /switch 共用同一个本地服务（127.0.0.1，无鉴权），
 * 语义上只做三件事：看版本、装版本、切版本。真正的"生效"要靠宿主重启。
 */

const ROUTES = new Set([
  "/versions",
  "/update/check",
  "/update/install",
  "/update/switch",
  "/update/rollback",
  "/update/delete",
  "/update/restart",
]);

export function isUpdateRoute(route) {
  return ROUTES.has(route);
}

/**
 * @param {{route: string, req: import("node:http").IncomingMessage, sendJson: Function,
 *          readBody: () => Promise<any>, config?: () => object}} ctx
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleUpdateRoute(ctx) {
  const { route, req, sendJson, readBody, config } = ctx;
  if (!ROUTES.has(route)) return false;
  const getConfig = typeof config === "function" ? config : () => config || {};

  if (route === "/versions" && req.method === "GET") {
    sendJson(200, { ok: true, ...status() });
    return true;
  }

  if (route === "/update/check" && (req.method === "GET" || req.method === "POST")) {
    const result = await check(getConfig(), { force: true });
    sendJson(200, { ok: true, ...result });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(405, { error: `${route} 只接受 POST` });
    return true;
  }

  const body = (await readBody()) || {};
  if (route === "/update/install") {
    if (!body.version) throw new Error("缺少 version");
    const record = await install(getConfig(), body.version, { force: body.force === true });
    sendJson(200, { ok: true, installed: record, versions: status() });
    return true;
  }
  if (route === "/update/switch") {
    if (!body.version) throw new Error("缺少 version");
    const result = switchTo(body.version);
    sendJson(200, { ok: true, ...result, versions: status() });
    return true;
  }
  if (route === "/update/rollback") {
    const result = rollback("panel");
    sendJson(200, { ok: true, ...result, versions: status() });
    return true;
  }
  if (route === "/update/delete") {
    if (!body.version) throw new Error("缺少 version");
    removeVersion(body.version);
    sendJson(200, { ok: true, versions: status() });
    return true;
  }
  if (route === "/update/restart") {
    // 不真的杀进程：只把 restart.cmd 写到 state 目录，用户双击执行。
    const script = writeRestartScript();
    sendJson(200, { ok: true, restart: script, versions: status() });
    return true;
  }
  return false;
}
