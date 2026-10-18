#!/usr/bin/env node
/**
 * 打包：dist/bingbing-<version>-dist.zip（发给别人）与 -portable.zip（自己备份）
 *
 * 精简包只放运行时需要的东西，省得别人解压出 tests/ 和一堆脚本不知道干嘛用。
 * 剔除 .tmp/ dist/ .git/ node_modules/ *.bak，以及不在精简清单里的目录。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const FULL = process.argv.includes("--full");
const OUT_DIR = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, "dist");
})();

/** 精简模式保留项；--full 模式下改为「根目录除 DENY 外的全部」。 */
const SLIM_KEEP = [
  "bin",
  "lib",
  "ui",
  "prompts",
  "docs",
  "install.cmd",
  "一键安装.cmd",
  "bingbing.cmd",
  "HOW-TO-INSTALL.txt",
  "package.json",
  "cordis.patch.yml",
  "NOTICE",
  "LICENSE",
  "README.md",
];
const KEEP = FULL ? fs.readdirSync(ROOT).filter((name) => !name.startsWith(".") && name !== "dist" && name !== "node_modules") : SLIM_KEEP;

/** 即使父目录保留，也要再剔一遍的东西。 */
const DENY = new Set([".DS_Store", "Thumbs.db", "node_modules", ".git", ".tmp", "dist"]);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const stageRoot = path.join(ROOT, ".tmp", "dist-stage");
const stage = path.join(stageRoot, "bingbing");
const zipPath = path.join(OUT_DIR, `bingbing-${pkg.version}-${FULL ? "portable" : "dist"}.zip`);

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function walk(from, to, seen = []) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (DENY.has(name) || name.endsWith(".bak")) continue;
      walk(path.join(from, name), path.join(to, name), seen);
    }
    return seen;
  }
  if (from.endsWith(".bak")) return seen;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  seen.push(path.relative(stage, to).replace(/\\/g, "/"));
  return seen;
}

// ---- 1. 校验源目录 ----
for (const item of KEEP) {
  if (!fs.existsSync(path.join(ROOT, item))) {
    console.error(`缺少必需项：${item}（精简包无法构成可运行插件）`);
    process.exit(1);
  }
}

// ---- 2. 清场 + 暂存 ----
rmrf(stageRoot);
fs.mkdirSync(stage, { recursive: true });
const staged = [];
for (const item of KEEP) walk(path.join(ROOT, item), path.join(stage, item), staged);

pkg.files = ["bin", "lib", "ui", "prompts", "cordis.patch.yml", "README.md", "LICENSE"];
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// ---- 3. 打包 ----
fs.mkdirSync(OUT_DIR, { recursive: true });
rmrf(zipPath);
const zipped = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (zipped.status !== 0) {
  console.error(`打包失败：${zipped.stderr || zipped.stdout}`);
  process.exit(1);
}
if (!fs.existsSync(zipPath)) {
  console.error(`打包后没找到 ${zipPath}`);
  process.exit(1);
}

// ---- 4. 报告 ----
const excluded = FULL ? ["仅剔除 .tmp/ dist/ .git/ node_modules/ *.bak"] : ["tests/", "tools/", "dist/", ".git/"];
const sizeKb = Math.round((fs.statSync(zipPath).size / 1024) * 10) / 10;
const files = staged.length + 1;
console.log(`\n▸ ${FULL ? "完整便携包" : "精简包"} ${path.basename(zipPath)}`);
console.log(`  ${files} 个文件，${sizeKb} KB`);
console.log(`  剔除：${excluded.join("  ")}`);
console.log(`  保留正文：${fs.existsSync(path.join(stage, "prompts", "v1", "prompt-inject.md")) ? "是" : "否"}`);
console.log(`  保留 v2 内核：${fs.existsSync(path.join(stage, "prompts", "v2", "core.md")) ? "是" : "否"}`);
console.log(`\n  输出：${zipPath}\n`);

rmrf(stageRoot);
