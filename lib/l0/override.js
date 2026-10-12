import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, stateRoot, writeJson } from "../core/state.js";

/**
 * 运行时覆盖层。
 *
 * 宿主在启动时只 apply() 一次，配置在那时被读进闭包；但我们的三段正文都是
 * thunk（每次 assemble 现读）。所以只要在**读取时**再叠一层 override.json，
 * 切换 promptSet / enabled 就能做到"下一轮组装即生效、不用重启"。
 *
 * 文件：$DSH_HOME/state/bingbing/override.json
 * 允许的键：enabled / promptSet / filterPolicyContexts / filterIdentitySections
 */

export function overridePath() {
  return path.join(stateRoot(), "override.json");
}

export function logPath() {
  return path.join(stateRoot(), "switch-log.jsonl");
}

/** 按 mtime 缓存的活读：每次 assemble 只会多一次 stat，不做重复 JSON 解析。 */
let cache = { mtimeMs: -1, value: null };

export function readOverride() {
  const fp = overridePath();
  let stat;
  try {
    stat = fs.statSync(fp);
  } catch {
    cache = { mtimeMs: -1, value: null };
    return null;
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.value;
  const parsed = readJson(fp, null);
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  cache = { mtimeMs: stat.mtimeMs, value };
  return value;
}

/** 合并写入（浅合并；传 null 的键会被删除）。返回写入后的完整对象。 */
export function writeOverride(patch) {
  const current = readOverride() || {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  next.updatedAt = new Date().toISOString();
  ensureDir(stateRoot());
  writeJson(overridePath(), next);
  cache = { mtimeMs: -1, value: null };
  return next;
}

export function clearOverride() {
  try {
    fs.unlinkSync(overridePath());
  } catch {
    /* 不存在即已清空 */
  }
  cache = { mtimeMs: -1, value: null };
  return true;
}

export function readSwitchLog(limit = 50) {
  try {
    const text = fs.readFileSync(logPath(), "utf8");
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function appendSwitchLog(entry) {
  try {
    ensureDir(stateRoot());
    fs.appendFileSync(logPath(), `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}
