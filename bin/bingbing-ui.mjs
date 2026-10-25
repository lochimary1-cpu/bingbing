#!/usr/bin/env node
/**
 * bingbing 开关台（独立服务，给"宿主没跑/想用浏览器看"的场景用）
 *
 * 日常请用客户端插件里的「越狱」按钮（对话输入框旁），那条走宿主内路由，
 * 不需要这个进程。这里的逻辑与宿主内路由共用 lib/l0/panel.js，不会漂移。
 *
 * 用法：node bin/bingbing-ui.mjs [--port 7311] [--open]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applyReset, applySwitch, buildState } from "../lib/l0/panel.js";
import { handleUpdateRoute } from "../lib/update/routes.js";
import { applyCors, rejectReason } from "../lib/core/http-guard.js";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const UI_DIR = path.join(PKG_ROOT, "ui");
const argv = process.argv.slice(2);
const portArg = Number((argv[argv.indexOf("--port") + 1] || "").trim());
const PORT = Number.isFinite(portArg) && portArg > 0 ? portArg : Number(process.env.BINGBING_UI_PORT || 7311);
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
})();

function sendJson(res, code, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`JSON 解析失败：${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

function serveStatic(res, rel) {
  const target = path.join(UI_DIR, rel);
  if (!target.startsWith(UI_DIR)) return res.writeHead(403).end("forbidden");
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(target)] || "application/octet-stream", "cache-control": "no-store", "content-length": body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route = url.pathname;
  try {
    // 与宿主内面板同一道闸：只接受回环 origin，跨站请求直接 403。
    // （本页是 same-origin，用户自己的 curl 不带 Origin，两者都放行。）
    applyCors(res, String(req.headers.origin ?? ""));
    const deny = rejectReason(req);
    if (deny) return sendJson(res, 403, { error: deny });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return undefined;
    }
    if (route === "/api/state" && req.method === "GET") return sendJson(res, 200, buildState());
    if (route === "/bingbing/api/state" && req.method === "GET") return sendJson(res, 200, buildState());

    if ((route === "/api/switch" || route === "/bingbing/api/switch") && req.method === "POST") {
      const applied = applySwitch(await readBody(req));
      return sendJson(res, 200, { ok: true, applied: { patch: applied.patch, after: applied.after }, state: buildState() });
    }
    if ((route === "/api/reset" || route === "/bingbing/api/reset") && req.method === "POST") {
      const applied = applyReset();
      return sendJson(res, 200, { ok: true, applied: { after: applied.after }, state: buildState() });
    }
    if ((route === "/api/verify" || route === "/bingbing/api/verify") && req.method === "GET") {
      const state = buildState();
      const rows = state.rows.map((row) => ({
        label: row.label,
        ok: row.ok,
        expected: row.textual ? row.expectedText : `${row.expected.bytes}B / ${String(row.expected.sha256).slice(0, 10)}`,
        actual: row.textual ? row.actualText : row.actual ? `${row.actual.bytes}B / ${String(row.actual.sha256).slice(0, 10)}` : "缺失",
      }));
      const verdict = state.evidence.matched ? "PASS" : state.evidence.pending ? "PENDING" : "FAIL";
      return sendJson(res, 200, { verdict, rows, evidence: state.evidence });
    }
    if (route === "/api/shutdown" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 120);
      return;
    }

    // 版本选择 / 更新：/api/versions 与 /api/update/*
    {
      const prefix = route.startsWith("/bingbing/api") ? "/bingbing/api" : "/api";
      const tail = route.slice(prefix.length) || "/";
      const handled = await handleUpdateRoute({
        route: tail,
        req,
        res,
        sendJson: (code, value) => sendJson(res, code, value),
        readBody: () => readBody(req),
        config: () => ({}),
      });
      if (handled) return;
    }
    if (route === "/" || route === "/index.html") return serveStatic(res, "index.html");
    if (route.startsWith("/ui/")) return serveStatic(res, route.slice(4));
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 400, { error: String((e && e.message) || e) });
  }
});

function listen(port, attemptsLeft) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`[bingbing-ui] 启动失败：${e.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const real = server.address().port;
    console.log(`[bingbing-ui] v${VERSION} → http://127.0.0.1:${real}`);
    if (argv.includes("--open")) spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${real}`], { detached: true, stdio: "ignore" }).unref();
  });
}

listen(PORT, 20);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
