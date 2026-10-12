import zlib from "node:zlib";

/**
 * 最小 tar.gz 读取器（零依赖）。
 *
 * 为什么不用 zip：Windows 的 zip 只有 Compress-Archive 会写，读侧要自己解 central directory；
 * 而 npm 形态的 .tgz 是 tar+gzip，zlib 一行就能解，tar 头是定长结构，代码更短、更好验。
 * 发布时同时上传 .tgz（更新器用）与 .zip（人手动装）。
 *
 * 支持：ustar、prefix 长路径、pax 扩展头（x/g）、普通文件与目录。
 * 不支持的会抛错而不是静默跳过——更新器宁可失败，也不要装出半个包。
 */

const BLOCK = 512;

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  const usable = end === -1 ? slice : slice.subarray(0, end);
  return usable.toString("utf8");
}

function readOctal(buf, offset, length) {
  const text = readString(buf, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`tar: 非法八进制字段 "${text}"`);
  return value;
}

/** pax 扩展头的记录格式：`<len> <key>=<value>\n`。 */
function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(i, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, i + length - 1).toString("utf8"); // 去掉结尾 \n
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/**
 * 解压 tar.gz，返回条目数组。
 * @param {Buffer} gz
 * @returns {{path: string, type: "file"|"dir", mode: number, data?: Buffer}[]}
 */
export function untarGz(gz) {
  const tar = zlib.gunzipSync(gz);
  const entries = [];
  let offset = 0;
  let override = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    if (header.every((byte) => byte === 0)) break; // 两个空块结束

    const name = readString(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    const data = size > 0 ? tar.subarray(dataStart, dataEnd) : Buffer.alloc(0);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x" || typeflag === "g") {
      const pax = parsePax(data);
      if (typeflag === "x") override = pax;
      continue;
    }
    if (typeflag === "L") {
      override = { path: readString(data, 0, data.length) };
      continue;
    }

    const fullPath = override?.path || (prefix ? `${prefix}/${name}` : name);
    override = null;
    if (!fullPath || fullPath === "./") continue;

    if (typeflag === "5") {
      entries.push({ path: fullPath.replace(/\/+$/, ""), type: "dir", mode });
      continue;
    }
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      entries.push({ path: fullPath, type: "file", mode, data: Buffer.from(data) });
      continue;
    }
    // 软链 / 设备节点：npm 包里不该出现，出现就是有问题
    throw new Error(`tar: 不支持的条目类型 "${typeflag}"（${fullPath}）`);
  }

  return entries;
}

/** 去掉首层目录（npm pack 会包一层 `package/`）。 */
export function stripTop(entries) {
  const paths = entries.map((entry) => entry.path.split("/")[0]);
  const tops = new Set(paths);
  if (tops.size !== 1) return entries;
  const top = [...tops][0];
  if (!top) return entries;
  return entries
    .map((entry) => ({ ...entry, path: entry.path.slice(top.length + 1) }))
    .filter((entry) => entry.path);
}

/** 路径安全：不允许绝对路径、盘符、`..`。 */
export function assertSafePath(rel) {
  const normalized = rel.replace(/\\/g, "/");
  if (!normalized) throw new Error("tar: 空路径");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error(`tar: 绝对路径 ${rel}`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`tar: 路径穿越 ${rel}`);
  return normalized;
}
