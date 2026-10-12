import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, stateRoot, writeJson } from "../core/state.js";
import { assertSafePath, stripTop, untarGz } from "./pack.js";

/**
 * 版本库：$DSH_HOME/state/bingbing/{versions/<ver>, current, versions.json, pending.json}
 *
 * 为什么要有 current 这一层：profile 的 `link:` 指向一个**稳定路径**，
 * 切版本只重定向 current 这个 junction，不动 profile/package.json/pnpm 清单。
 * 这样"更新"不需要 pnpm、不需要重装、不需要写宿主目录。
 */

const SCHEMA = 1;

export const versionsDir = () => path.join(stateRoot(), "versions");
export const currentPath = () => path.join(stateRoot(), "current");
export const registryPath = () => path.join(stateRoot(), "versions.json");
export const pendingPath = () => path.join(stateRoot(), "pending.json");
export const versionDir = (ver) => path.join(versionsDir(), String(ver));

/* ── 链接工具（Windows junction）──────────────────────────────────────── */

function lstatSafe(fp) {
  try {
    return fs.lstatSync(fp);
  } catch {
    return null;
  }
}

export function readLink(fp) {
  const st = lstatSafe(fp);
  if (!st || !st.isSymbolicLink()) return null;
  try {
    return fs.readlinkSync(fp);
  } catch {
    return null;
  }
}

export function isLink(fp) {
  const st = lstatSafe(fp);
  return Boolean(st && st.isSymbolicLink());
}

/** 原子换向：先建新链接，再改名换位，失败回滚。 */
export function replaceJunction(linkPath, target) {
  ensureDir(path.dirname(linkPath));
  ensureDir(target);
  const stamp = `${process.pid}-${Date.now()}`;
  const next = `${linkPath}.next-${stamp}`;
  const prev = `${linkPath}.prev-${stamp}`;
  fs.symlinkSync(target, next, "junction");
  const existed = isLink(linkPath) || fs.existsSync(linkPath);
  try {
    if (existed) fs.renameSync(linkPath, prev);
    fs.renameSync(next, linkPath);
  } catch (error) {
    try {
      fs.rmSync(next, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (existed && !lstatSafe(linkPath) && lstatSafe(prev)) {
      try {
        fs.renameSync(prev, linkPath);
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
  if (existed) fs.rmSync(prev, { recursive: true, force: true });
  return target;
}

/* ── 登记表 ───────────────────────────────────────────────────────────── */

export function readRegistry() {
  const raw = readJson(registryPath(), null);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.versions)) {
    return { schema: SCHEMA, versions: [], active: null };
  }
  return { schema: raw.schema ?? SCHEMA, versions: raw.versions.filter((v) => v && v.ver), active: raw.active ?? null };
}

export function writeRegistry(next) {
  return writeJson(registryPath(), { schema: SCHEMA, ...next, updatedAt: new Date().toISOString() });
}

/** 磁盘上的版本目录（以目录为准，登记表只是元数据）。 */
export function scanVersions() {
  const dir = versionsDir();
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  return names.sort(compareVersion);
}

/** 版本号比较：按数值段，0.10.0 > 0.9.0；非数字段按字符串。 */
export function compareVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 当前生效版本：优先读 current 链接；外链版本按登记表反查；最后退回归档的 active 字段。 */
export function activeVersion() {
  const target = readLink(currentPath());
  if (target) {
    const reg = readRegistry();
    const resolved = (() => {
      try {
        return path.resolve(fs.realpathSync(target));
      } catch {
        return path.resolve(target);
      }
    })().toLowerCase();
    const linked = reg.versions.find((item) => item.target && path.resolve(item.target).toLowerCase() === resolved);
    if (linked) return linked.ver;
    const ver = path.basename(target);
    if (ver) return ver;
  }
  const reg = readRegistry();
  return reg.active ?? null;
}

/** 读版本目录里的 package.json（不存在返回 null）。 */
export function versionMeta(ver) {
  return readJson(path.join(versionDir(ver), "package.json"), null);
}

/* ── 待激活 / 自动回滚 ────────────────────────────────────────────────── */

export function readPending() {
  const raw = readJson(pendingPath(), null);
  return raw && typeof raw === "object" && raw.to ? raw : null;
}

export function writePending(value) {
  return writeJson(pendingPath(), value);
}

export function clearPending() {
  try {
    fs.rmSync(pendingPath(), { force: true });
  } catch {
    /* ignore */
  }
}

/* ── 安装 / 删除 ──────────────────────────────────────────────────────── */

/**
 * 从 tgz 安装一个版本。
 * @param {Buffer} gz
 * @param {{ source?: string, expect?: string }} options
 */
export function installTgz(gz, options = {}) {
  const entries = stripTop(untarGz(gz));
  const pkgEntry = entries.find((entry) => entry.path === "package.json" && entry.type === "file");
  if (!pkgEntry) throw new Error("tgz 里没有 package.json：不是 bingbing 的发行包");
  const pkg = JSON.parse(pkgEntry.data.toString("utf8"));
  if (pkg.name !== "bingbing") throw new Error(`tgz 的包名是 "${pkg.name}"，不是 bingbing`);
  const ver = String(pkg.version || "");
  if (!ver) throw new Error("tgz 的 package.json 没有 version");
  if (options.expect && options.expect !== ver) throw new Error(`版本不符：期望 ${options.expect}，包内是 ${ver}`);

  const target = versionDir(ver);
  const staging = path.join(stateRoot(), ".staging", `${ver}-${process.pid}-${Date.now()}`);
  ensureDir(staging);

  for (const entry of entries) {
    const rel = assertSafePath(entry.path);
    const dest = path.join(staging, rel);
    if (entry.type === "dir") {
      ensureDir(dest);
      continue;
    }
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, entry.data);
  }

  const existed = fs.existsSync(target);
  if (existed) fs.rmSync(target, { recursive: true, force: true });
  ensureDir(path.dirname(target));
  fs.renameSync(staging, target);
  try {
    fs.rmSync(path.dirname(staging), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const reg = readRegistry();
  const others = reg.versions.filter((item) => item.ver !== ver);
  const files = entries.filter((entry) => entry.type === "file").length;
  const record = {
    ver,
    installedAt: new Date().toISOString(),
    source: options.source || "manual",
    bytes: gz.length,
    files,
    replaced: existed,
  };
  const next = { ...reg, versions: [...others, record].sort((a, b) => compareVersion(a.ver, b.ver)) };
  writeRegistry(next);
  return record;
}

export function removeVersion(ver) {
  const reg = readRegistry();
  const active = activeVersion();
  if (String(ver) === String(active)) throw new Error(`不能删除正在生效的版本 ${ver}，先切到别的版本`);
  const dir = versionDir(ver);
  if (!fs.existsSync(dir)) throw new Error(`版本 ${ver} 没有安装`);
  fs.rmSync(dir, { recursive: true, force: true });
  writeRegistry({ ...reg, versions: reg.versions.filter((item) => item.ver !== String(ver)) });
  return true;
}

/** 把 current 指向某个已安装版本，并记下 pending 供下次启动确认。 */
export function activate(ver, options = {}) {
  const reg = readRegistry();
  const entry = reg.versions.find((item) => item.ver === String(ver));
  const target = entry?.target || versionDir(ver);
  if (!fs.existsSync(target)) throw new Error(`版本 ${ver} 没有安装（${target} 不存在）`);
  const from = activeVersion();
  replaceJunction(currentPath(), target);
  writeRegistry({ ...reg, active: String(ver) });
  if (options.pending !== false && from && String(from) !== String(ver)) {
    writePending({ from: String(from), to: String(ver), at: new Date().toISOString(), attempts: 0 });
  }
  return { from, to: String(ver) };
}

/**
 * 登记一个"外链版本"：不复制文件，只把 current 指向一个已有目录。
 * 用于开发模式——仓库本身就是其中一个可切换的版本。
 */
export function registerLinked(ver, target, meta = {}) {
  const reg = readRegistry();
  const others = reg.versions.filter((item) => item.ver !== String(ver));
  const record = {
    ver: String(ver),
    installedAt: new Date().toISOString(),
    source: meta.source || "linked",
    files: null,
    bytes: null,
    target: path.resolve(target),
  };
  writeRegistry({ ...reg, versions: [...others, record].sort((a, b) => compareVersion(a.ver, b.ver)) });
  return record;
}

/** 把 current 指到一个外部目录（开发仓库），不写 pending——这不是升级。 */
export function linkCurrent(target) {
  ensureDir(path.dirname(currentPath()));
  replaceJunction(currentPath(), target);
  return currentPath();
}
