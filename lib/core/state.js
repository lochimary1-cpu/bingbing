import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** 进程标识：每个宿主进程一份。装配快照里带上它，
 * 结算（settlePending）才能区分"本进程刚组装过"和"读到的还是上一个进程的快照"。 */
export const BOOT_ID = crypto.randomUUID();

/** 统一 sha256：字符串按 utf8，Buffer 原样。 */
export function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** $DSH_HOME，缺省 ~/.dsh。 */
export function dshHome() {
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) return env;
  return path.join(os.homedir(), ".dsh");
}

/**
 * 插件状态根：$DSH_HOME/state/bingbing
 * 刻意不与仓库目录（~/.dsh/bingbing）重叠，避免运行时文件写进包根。
 */
export function stateRoot() {
  return path.join(dshHome(), "state", "bingbing");
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

export function readJson(fp, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写：唯一 tmp + rename，失败返回 false，绝不抛给宿主。 */
export function writeJson(fp, value) {
  try {
    ensureDir(path.dirname(fp));
    const tmp = `${fp}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

export function appendJsonl(fp, value) {
  try {
    ensureDir(path.dirname(fp));
    fs.appendFileSync(fp, `${JSON.stringify(value)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readText(fp) {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

export function fileBytes(fp) {
  try {
    return fs.statSync(fp).size;
  } catch {
    return null;
  }
}
