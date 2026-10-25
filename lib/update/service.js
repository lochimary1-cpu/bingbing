import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome, readJson, stateRoot, writeJson } from "../core/state.js";
import { downloadAsset, listInstallable } from "./github.js";
import {
  activate,
  activeVersion,
  clearPending,
  currentPath,
  installTgz,
  isLink,
  readLink,
  readPending,
  readRegistry,
  versionsDir,
} from "./registry.js";

/**
 * 版本服务：检查 / 安装 / 切换 / 回滚 / 重启脚本。
 *
 * 边界：宿主 lib/ 的代码是 ESM，进程内换不掉；所以"切版本"只重定向 current，
 * 真正生效要宿主重启一次。客户端 UI 那半边能被宿主 HMR 侦测到（500ms stat 轮询），
 * 但我们不依赖它——版本切换一律按"需重启"提示，避免半个新半个旧。
 */

const MARKER = () => path.join(stateRoot(), "rollback-needed.json");
const TOKEN_FILE = () => path.join(stateRoot(), "github-token.txt");

/** 私有仓用的 read-only token：环境变量优先，其次 state/bingbing/github-token.txt。 */
export function readStoredToken() {
  try {
    return String(fs.readFileSync(TOKEN_FILE(), "utf8")).trim();
  } catch {
    return "";
  }
}

export function writeToken(token) {
  const text = String(token || "").trim();
  if (!text) {
    fs.rmSync(TOKEN_FILE(), { force: true });
    return null;
  }
  fs.mkdirSync(path.dirname(TOKEN_FILE()), { recursive: true });
  fs.writeFileSync(TOKEN_FILE(), `${text}\n`, "utf8");
  return TOKEN_FILE();
}

/** 生效配置（来自 cordis.patch.yml 的 update 段，缺省走默认）。 */
export function updateConfig(config) {
  const raw = (config && config.update) || {};
  return {
    repo: String(raw.repo || "lochimary1-cpu/bingbing"),
    token: String(process.env.BINGBING_UPDATE_TOKEN || process.env.GITHUB_TOKEN || readStoredToken() || ""),
    autoCheck: raw.autoCheck !== false,
  };
}

/** 这个包是不是装进版本库里的（而不是开发时的 link: 仓库）。 */
export function isManaged() {
  const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const versions = path.resolve(versionsDir());
  return root.toLowerCase().startsWith(versions.toLowerCase() + path.sep);
}

export function status() {
  const reg = readRegistry();
  const active = activeVersion();
  const installed = new Set();
  try {
    for (const name of fs.readdirSync(versionsDir(), { withFileTypes: true })) {
      if (name.isDirectory()) installed.add(name.name);
    }
  } catch {
    /* 没有版本库就是空 */
  }
  const meta = new Map(reg.versions.map((item) => [item.ver, item]));
  const versions = [...installed]
    .concat(reg.versions.filter((item) => item.target && !installed.has(item.ver)).map((item) => item.ver))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((ver) => ({
      ver,
      active: ver === active,
      installedAt: meta.get(ver)?.installedAt ?? null,
      source: meta.get(ver)?.source ?? "unknown",
      kind: meta.get(ver)?.target ? "linked" : "version",
      files: meta.get(ver)?.files ?? null,
      bytes: meta.get(ver)?.bytes ?? null,
    }));
  return {
    // managed = 版本库这一层已经启用（current 存在）；与"当前跑的是哪份代码"无关
    managed: isLink(currentPath()) || versions.length > 0,
    active,
    activeKind: meta.get(active)?.target ? "linked" : active ? "version" : null,
    running: runningVersion(),
    currentLink: readLink(currentPath()),
    currentIsLink: isLink(currentPath()),
    pending: readPending(),
    rollbackNeeded: readJson(MARKER(), null),
    tokenConfigured: Boolean(updateConfig({}).token),
    restart: {
      path: restartScriptPath(),
      exists: fs.existsSync(restartScriptPath()),
    },
    versions,
    paths: { versions: versionsDir(), current: currentPath(), state: stateRoot(), dshHome: dshHome(), restart: restartScriptPath() },
  };
}

/** 正在运行的这份代码的版本号（开发模式下等于仓库 package.json）。 */
export function runningVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
    return String(pkg.version || "") || null;
  } catch {
    return null;
  }
}

/** 远端可装列表 + 本地状态合成一张表。 */
export async function check(config, options = {}) {
  const cfg = updateConfig(config);
  const local = status();
  // 跑的是外链版本（dev 仓库）时，"当前版本"取正在运行的 package.json，
  // 否则面板会永远显示"有新版本"。
  const current = local.activeKind === "linked" ? runningVersion() : local.active;
  const installedByVer = new Map(local.versions.map((item) => [item.ver, item]));
  const remote = await listInstallable({ repo: cfg.repo, token: cfg.token, force: options.force });
  const rows = remote.items.map((item) => ({
    ...item,
    installed: installedByVer.has(item.version),
    active: item.version === current,
  }));
  const latest = rows.find((row) => !row.prerelease) || rows[0] || null;
  return {
    repo: cfg.repo,
    checkedAt: remote.at,
    cached: Boolean(remote.cached),
    stale: Boolean(remote.stale),
    latest: latest ? latest.version : null,
    active: current,
    updateAvailable: Boolean(latest && latest.version !== current),
    rows,
    local,
  };
}

/** 下载并解包某个版本（不激活）。 */
export async function install(config, version) {
  const cfg = updateConfig(config);
  const findRow = async (force) => {
    const remote = await listInstallable({ repo: cfg.repo, token: cfg.token, force });
    return { remote, row: remote.items.find((item) => item.version === String(version)) };
  };
  let { remote, row } = await findRow(true);
  if (!row) throw new Error(`远端没有 ${version}（可选：${remote.items.map((i) => i.version).join(", ") || "无"}）`);
  let buffer;
  try {
    buffer = await downloadAsset(row.asset, { token: cfg.token });
  } catch (error) {
    // 资产被删/换了（删除 release 之后缓存里的 asset url 就 404）：清缓存重列一次再试
    if (!/HTTP 404/.test(String(error.message))) throw error;
    fs.rmSync(path.join(stateRoot(), "update-cache.json"), { force: true });
    ({ remote, row } = await findRow(true));
    if (!row) throw new Error(`远端没有 ${version}（资产 404，重列后仍找不到）`);
    buffer = await downloadAsset(row.asset, { token: cfg.token });
  }
  const record = installTgz(buffer, { source: `github:${cfg.repo}`, expect: row.version });
  return { ...record, asset: row.asset.name };
}

/** 激活某个已安装版本；写 pending，生成 restart.cmd。 */
export function switchTo(version) {
  const result = activate(version);
  const restart = writeRestartScript();
  return { ...result, restart, needsRestart: true };
}

/** 回滚到 pending.from（自动回滚与手动回滚共用）。 */
export function rollback(reason = "manual") {
  const pending = readPending();
  if (!pending?.from) throw new Error("没有可回滚的目标（pending.json 不存在）");
  activate(pending.from, { pending: false });
  clearPending();
  writeJson(MARKER(), { at: new Date().toISOString(), from: pending.to, to: pending.from, reason });
  return { to: pending.from, from: pending.to, reason };
}

/**
 * 启动后结算 pending。
 * - 探针全过 → 确认这次切换，清 pending
 * - 探针有 FAIL → 自动切回上一版，清 pending，并留 marker 让面板提示再重启一次
 * 只有明确的 FAIL 才回滚；N/A（还没组装过 / 快照来自别的进程）一律不下判断。
 */
export function settlePending(probe) {
  const pending = readPending();
  if (!pending) return { settled: false, reason: "no-pending" };
  const active = activeVersion();
  if (String(active) !== String(pending.to)) {
    // 已经不在待确认版本上：可能被自动回滚过、或用户手动切走了。
    // 旧代码把 pending 留在原地 → 面板永远显示"待生效"，且后续结算全部
    // 走 pending-not-active 死循环。这里自愈：清掉，状态以 marker 为准。
    clearPending();
    return { settled: false, reason: "pending-not-active", cleared: true, active };
  }

  let verdict = null;
  try {
    verdict = probe ? probe() : null;
  } catch {
    verdict = null;
  }
  if (!verdict) return { settled: false, reason: "no-probe" };

  if (verdict.verdict === "PASS") {
    clearPending();
    return { settled: true, action: "confirmed", version: pending.to };
  }
  const failures = (verdict.probes || []).filter((item) => item.ok === false).length;
  if (failures === 0) return { settled: false, reason: "probe-inconclusive" };

  if ((pending.attempts || 0) >= 2) {
    clearPending();
    return { settled: false, reason: "too-many-attempts", failures };
  }
  try {
    activate(pending.from, { pending: false });
    // 回滚完成 = 这次"待确认"已经处理过。留着 pending 会让面板同时显示
    // "已切到 X 待生效"和"上次已回滚"，而且再也不会被结算。
    clearPending();
    writeJson(MARKER(), {
      at: new Date().toISOString(),
      from: pending.to,
      to: pending.from,
      reason: `auto-rollback: ${failures} probe(s) failed`,
      attempts: (pending.attempts || 0) + 1,
    });
    return { settled: true, action: "rolled-back", to: pending.from, failures };
  } catch (error) {
    return { settled: false, reason: `rollback-failed: ${error.message}` };
  }
}

/* ── 重启脚本 ─────────────────────────────────────────────────────────── */

const EXE_CANDIDATES = [
  () => path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness", "DeepSeek Harness.exe"),
  () => path.join(process.env.PROGRAMFILES || "", "DeepSeek Harness", "DeepSeek Harness.exe"),
  () => (process.execPath && /DeepSeek/i.test(process.execPath) ? process.execPath : ""),
];

export function findAppExe() {
  for (const candidate of EXE_CANDIDATES) {
    try {
      const fp = candidate();
      if (fp && fs.existsSync(fp)) return fp;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function restartScriptPath() {
  return path.join(stateRoot(), "restart.cmd");
}

/** 写 state/bingbing/restart.cmd；返回 {path, exe}。 */
export function writeRestartScript() {
  const exe = findAppExe();
  const file = restartScriptPath();
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "echo 正在重启 DeepSeek Harness ...",
    'taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1',
    "timeout /t 2 /nobreak >nul",
  ];
  if (exe) lines.push(`start "" "${exe}"`);
  else lines.push('echo 没找到 DeepSeek Harness.exe，请从托盘退出再手动打开。', "pause");
  lines.push("exit /b 0");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\r\n")}\r\n`, "utf8");
  return { path: file, exe };
}
