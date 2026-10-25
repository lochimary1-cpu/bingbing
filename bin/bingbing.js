#!/usr/bin/env node
/**
 * bingbing CLI —— 安装 / 卸载 / 体检 一条命令搞定，不依赖 PowerShell 执行策略。
 *
 *   bingbing install     写 profile 挂载点（幂等，先备份），提示重启
 *   bingbing uninstall   摘掉挂载点（保留状态目录）
 *   bingbing doctor      自测 + 客户端契约 + 全量验收，一条命令给结论
 *   bingbing which       现在是哪套越狱 + 证据是否对得上
 *   bingbing status      插件状态 + 静态探针 S1–S5
 *   bingbing check       只跑静态探针
 *   bingbing paths       状态目录与证据文件路径
 *
 * 设计约束：只写 $DSH_HOME/profiles/<profile> 与自身状态目录；每一步先备份；
 * 重复执行结果不变（幂等）；任何一步失败立刻停并保留备份。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, stateRoot } from "../lib/core/state.js";
import { resolveCore } from "../lib/l0/prompt.js";
import { buildState } from "../lib/l0/panel.js";
import { staticProbes } from "../lib/core/canary.js";
import {
  check as updateCheck,
  install as updateInstall,
  readStoredToken,
  rollback as updateRollback,
  status as updateStatus,
  switchTo as updateSwitch,
  writeRestartScript,
  writeToken,
} from "../lib/update/service.js";
import { currentPath, isLink, linkCurrent, readRegistry, registerLinked } from "../lib/update/registry.js";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PROFILE = process.env.DSH_PROFILE || "desktop";
const PROFILE_DIR = path.join(DSH_HOME, "profiles", PROFILE);

const USAGE = `bingbing ${PKG.version} —— DSH 插件

  bingbing install            挂到当前 profile（幂等，自动备份），然后重启宿主
  bingbing uninstall          从 profile 摘掉（保留状态目录）
  bingbing doctor             自测 + 客户端契约 + 全量验收，一条命令出结论
  bingbing which  [--json]    现在是哪套越狱 + 证据是否对得上
  bingbing status [--json]    插件状态 + 静态探针 S1–S5
  bingbing check  [--json]    只跑静态探针（非 PASS 时退出码 1）
  bingbing paths  [--json]    状态目录与证据文件路径
  bingbing update status      已安装版本 / 当前生效 / 待重启
  bingbing update check       查 GitHub Releases 有没有新版
  bingbing update install X   下载并解包 X（或 latest），不激活
                              --force 覆盖正在生效的版本（默认拒绝）
  bingbing update switch X    切到 X，并生成 restart.cmd
  bingbing update rollback    切回上一版（pending.from）
  bingbing update restart     生成 restart.cmd（双击重启宿主）
  bingbing update token [PAT] 私有仓用的 read-only token（公开仓不用）

  常用开关：--dry-run（install/uninstall 只打印将要做什么）
            --managed（install 时启用版本库：node_modules/bingbing → state/bingbing/current）
  环境变量：DSH_HOME（默认 ~/.dsh）、DSH_PROFILE（默认 desktop）

日常用不到这几条命令 —— 装好后在 GUI 对话框旁点「越狱」按钮就能切版本。
`;

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const dryRun = argv.includes("--dry-run");
const managed = argv.includes("--managed");
const wantsHelp = argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
const command = argv.find((arg) => !arg.startsWith("-")) || "status";

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);

/** 时间戳备份：只在真的要改文件时调用。 */
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

function writeFile(file, text) {
  const bak = backup(file);
  fs.writeFileSync(file, text, "utf8");
  return bak;
}

/* ── install / uninstall ──────────────────────────────────────────────── */

function ensureProfile() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(`找不到 profile 目录：${PROFILE_DIR}（用 DSH_PROFILE 指定别的 profile）`);
  }
}

/** node_modules/bingbing → 本仓库（junction，改源码即生效）
 *  --managed 时改为指向 $DSH_HOME/state/bingbing/current，让"切版本"只换这一层。 */
function linkModule() {
  const dest = path.join(PROFILE_DIR, "node_modules", "bingbing");
  const src = managed ? currentPath() : PKG_ROOT.replace(/[\\/]+$/, "");
  if (fs.existsSync(dest) || isLink(dest)) {
    let current = null;
    try {
      current = fs.realpathSync(dest);
    } catch {
      current = null;
    }
    const want = (() => {
      try {
        return fs.realpathSync(src);
      } catch {
        return path.resolve(src);
      }
    })();
    if (current && path.resolve(current) === path.resolve(want)) {
      // --managed 下 realpath 相等还不够：node_modules 必须指向 current 这一层，
      // 否则切版本时它仍然直连仓库/旧版本目录，等于绕过 current。
      if (managed && isLink(dest)) {
        const raw = (() => {
          try {
            return fs.readlinkSync(dest);
          } catch {
            return "";
          }
        })();
        const pointsToCurrent = path.resolve(path.dirname(dest), raw).toLowerCase() === path.resolve(src).toLowerCase();
        if (!pointsToCurrent) {
          if (dryRun) {
            ok(`将把 node_modules/bingbing 改为指向 ${src}`);
            return "would-retarget";
          }
          fs.unlinkSync(dest);
          fs.symlinkSync(src, dest, "junction");
          ok(`已改为指向 current：node_modules/bingbing → ${src}`);
          return "retargeted";
        }
      }
      ok(`已挂载：node_modules/bingbing → ${src}`);
      return "unchanged";
    }
    // 已存在但是个 junction：直接换向（--managed 迁移时就是这个分支）
    if (isLink(dest)) {
      if (dryRun) {
        ok(`将把 node_modules/bingbing 从 ${current ?? "?"} 换向 ${src}`);
        return "would-retarget";
      }
      const prev = fs.readlinkSync(dest);
      try {
        fs.unlinkSync(dest);
        fs.symlinkSync(src, dest, "junction");
        ok(`已换向：node_modules/bingbing → ${src}（原 ${prev}）`);
        return "retargeted";
      } catch (e) {
        warn(`换向失败：${e.message}`);
        return "skipped";
      }
    }
    warn(`node_modules/bingbing 已存在但指向 ${current ?? "未知"}，跳过（先手动删除再重试）`);
    return "skipped";
  }
  if (dryRun) {
    ok(`将创建 junction：node_modules/bingbing → ${src}`);
    return "would-create";
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(src, dest, "junction");
  ok(`已挂载：node_modules/bingbing → ${src}`);
  return "created";
}

/** --managed：建版本库骨架，current → 本仓库，登记成 dev 版本。 */
function ensureManaged() {
  if (!managed) return "off";
  ensureDir(path.dirname(currentPath()));
  const reg = readRegistry();
  const dev = reg.versions.find((item) => item.ver === "dev");
  if (!isLink(currentPath())) {
    if (dryRun) return "would-init";
    linkCurrent(PKG_ROOT.replace(/[\\/]+$/, ""));
    ok(`版本库已初始化：current → ${PKG_ROOT}`);
  }
  if (!dev) {
    if (!dryRun) registerLinked("dev", PKG_ROOT.replace(/[\\/]+$/, ""), { source: "repo" });
  }
  return "managed";
}

/** profile 的 package.json：bundles 里加 bingbing，dependencies 里加 link: */
function patchPackage() {
  const file = path.join(PROFILE_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const src = managed ? currentPath() : PKG_ROOT.replace(/[\\/]+$/, "");
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const hadBundle = bundles.includes("bingbing");
  if (!hadBundle) bundles.push("bingbing");
  pkg.dsh.profile.bundles = bundles;
  pkg.dependencies = pkg.dependencies || {};
  const wantDep = `link:${src}`;
  const hadDep = pkg.dependencies.bingbing === wantDep;
  if (!hadDep) pkg.dependencies.bingbing = wantDep;

  if (hadBundle && hadDep) {
    ok("profile package.json 已包含 bingbing");
    return "unchanged";
  }
  if (dryRun) {
    ok("将更新 profile package.json（bundles + dependencies）");
    return "would-update";
  }
  const bak = writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  ok(`已更新 profile package.json${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
  return "updated";
}

const PATCH_BLOCK = `
# bingbing：三段投递 + 策略上下文过滤 + 运行时开关台（UI 切换写 override.json）
- id: bingbing
  name: bingbing
  config:
    enabled: true
    promptSet: 'v1+shell'
    promptOrder: 5100
    filterPolicyContexts: true
    filterIdentitySections: true
    trace: true
`;

/** profile 的 cordis.patch.yml：没有 bingbing 就追加一段 */
function patchLoader() {
  const file = path.join(PROFILE_DIR, "cordis.patch.yml");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^\s*-\s*id:\s*bingbing\s*$/m.test(existing)) {
    ok("cordis.patch.yml 已有 bingbing 挂载");
    return "unchanged";
  }
  if (dryRun) {
    ok("将在 cordis.patch.yml 追加 bingbing 挂载段");
    return "would-append";
  }
  const bak = writeFile(file, `${existing.replace(/\s*$/, "\n")}${PATCH_BLOCK}`);
  ok(`已追加挂载段${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
  return "appended";
}

function uninstall() {
  ensureProfile();
  const results = {};

  step("摘掉 loader 挂载");
  const patchFile = path.join(PROFILE_DIR, "cordis.patch.yml");
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, "utf8");
    // 只删 bingbing 那一段（从 - id: bingbing 到下一个同级条目或文件末尾）
    const next = text.replace(/\n?# bingbing[^\n]*\n-\s*id:\s*bingbing\n(?:[ \t]+.*\n)*/m, "\n");
    if (next !== text) {
      if (dryRun) {
        ok("将删除 cordis.patch.yml 里的 bingbing 段");
      } else {
        const bak = writeFile(patchFile, next);
        ok(`已删除挂载段${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
      }
      results.patch = "removed";
    } else {
      ok("cordis.patch.yml 里没有 bingbing 段");
      results.patch = "absent";
    }
  }

  step("摘掉模块链接");
  const dest = path.join(PROFILE_DIR, "node_modules", "bingbing");
  if (fs.existsSync(dest)) {
    if (dryRun) {
      ok(`将删除 ${dest}`);
    } else {
      try {
        fs.unlinkSync(dest);
        ok("已删除 node_modules/bingbing");
      } catch (e) {
        warn(`删除失败（可能是真实目录）：${e.message}`);
      }
    }
    results.link = "removed";
  } else {
    ok("node_modules/bingbing 不存在");
    results.link = "absent";
  }

  step("摘掉 profile 清单");
  const pkgFile = path.join(PROFILE_DIR, "package.json");
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    const bundles = pkg && pkg.dsh && pkg.dsh.profile ? pkg.dsh.profile.bundles : undefined;
    let changed = false;
    if (Array.isArray(bundles) && bundles.includes("bingbing")) {
      pkg.dsh.profile.bundles = bundles.filter((item) => item !== "bingbing");
      changed = true;
    }
    if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, "bingbing")) {
      delete pkg.dependencies.bingbing;
      changed = true;
    }
    if (!changed) ok("profile package.json 里没有 bingbing");
    else if (dryRun) ok("将从 profile package.json 移除 bingbing（bundles + dependencies）");
    else {
      const bak = writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
      ok(`已从 profile package.json 移除${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
    }
    results.package = changed ? "removed" : "absent";
  }

  step("保留状态目录");
  ok(`保留 ${stateRoot()}（含切换记录）`);
  console.log("\n重启宿主后生效。\n");
  return results;
}

function install() {
  ensureProfile();
  step(`安装到 profile「${PROFILE}」`);
  const results = { managed: ensureManaged() };
  results.module = linkModule();
  results.package = patchPackage();
  results.loader = patchLoader();

  if (json) {
    print({ profile: PROFILE, profileDir: PROFILE_DIR, dryRun, ...results });
    return results;
  }

  step("下一步");
  // 装完就把重启脚本备好：用户不用再等"切换版本"才见到 restart.cmd。
  try {
    const script = writeRestartScript();
    console.log(`  重启脚本 : ${script.path}${script.exe ? "（双击即重启）" : "（没找到 exe，脚本会提示手动打开）"}`);
  } catch (e) {
    warn(`生成重启脚本失败：${e.message}`);
  }
  console.log("  1. 托盘退出 DeepSeek Harness，再重新打开");
  console.log("  2. 在 GUI 发一句话，输入框右边会出现「越狱」按钮");
  console.log("  3. 点开它切版本；之后改提示词都不用再重启\n");
  console.log("  自检：node bin\\bingbing.js doctor\n");
  return results;
}

/* ── doctor ───────────────────────────────────────────────────────────── */

const NODE = process.execPath;

function runNode(script, label) {
  const started = Date.now();
  const r = spawnSync(NODE, [path.join(PKG_ROOT, script)], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, BINGBING_NO_PANEL: "1" },
    windowsHide: true,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return {
    label,
    script,
    code: r.status,
    ms: Date.now() - started,
    tail: out.trim().split(/\r?\n/).slice(-3).join(" / "),
  };
}

function doctor() {
  step("体检");
  // dist（精简包）不附带 tests/ tools/，这里必须优雅跳过而不是报 ENOENT 失败。
  const specs = [
    ["tests/selftest.mjs", "机制自测"],
    ["tools/check-client.mjs", "客户端插件契约"],
    ["tools/acceptance.mjs", "全量验收"],
  ];
  const checks = specs.map(([script, label]) => {
    if (!fs.existsSync(path.join(PKG_ROOT, script))) {
      return { label, script, code: 0, ms: 0, tail: "", skipped: true };
    }
    return runNode(script, label);
  });
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.skipped) {
      skipped += 1;
      console.log(`  – ${c.label.padEnd(12)} SKIP  (精简包未附带 ${c.script})`);
      continue;
    }
    const good = c.code === 0;
    if (!good) failed += 1;
    console.log(`  ${good ? "✓" : "✗"} ${c.label.padEnd(12)} ${good ? "PASS" : "FAIL"}  (${c.ms} ms)`);
    if (!good) console.log(`      ${c.tail}`);
  }
  // 自检工具全部缺席时，至少证明运行时能起来（读配置 + 解析三段 + 跑静态探针）。
  // 注意：刚装完还没组装过，四段本来就会显示"待生效"，这不算失败——
  // 这里只验"能不能读出来"，不验"是否已生效"（那要靠证据表/which）。
  if (skipped === checks.length) {
    try {
      const state = buildState();
      const pending = state.rows.filter((row) => !row.ok).length;
      console.log(
        `  ✓ ${"运行时状态".padEnd(10)} PASS  (${state.rows.length} 段${pending ? `，${pending} 段待下次组装` : "，全部已生效"})`,
      );
    } catch (error) {
      failed += 1;
      console.log(`  ✗ 运行时状态   FAIL  (${error.message})`);
    }
  }
  console.log("");
  if (failed === 0) {
    console.log(skipped ? "结论：运行时正常（精简包不含自检工具，已跳过 3 项）。\n" : "结论：全部通过。\n");
  } else {
    console.log(`结论：${failed} 项失败 —— 按上面提示处理；先跑 install --dry-run 看挂载是否正确。\n`);
  }
  return failed;
}

/* ── 原有命令 ─────────────────────────────────────────────────────────── */

function effectiveConfig() {
  const status = readJson(path.join(stateRoot(), "status.json"), null);
  return status && status.configUsed && typeof status.configUsed === "object" ? status.configUsed : {};
}

function probeSummary() {
  const config = effectiveConfig();
  const core = resolveCore(config);
  return { config, core, probes: staticProbes(core) };
}

function renderProbes(probes) {
  for (const probe of probes.probes) {
    const mark = probe.ok === true ? "PASS" : probe.ok === false ? "FAIL" : "N/A ";
    console.log(`${probe.id} ${mark} ${probe.name} — ${probe.detail}`);
  }
  console.log(`verdict: ${probes.summary.verdict}`);
}

function which() {
  const state = buildState();
  const eff = state.effective;
  const preset = (state.presets || []).find((item) => item.id === state.preset);
  const label = preset ? preset.label : state.preset;
  if (json) {
    print({
      preset: state.preset,
      label,
      effective: eff,
      expected: { pre: state.expected.pre.bytes, core: state.expected.core.bytes, post: state.expected.post.bytes },
      actual: {
        pre: state.actual.pre ? state.actual.pre.bytes : null,
        core: state.actual.core ? state.actual.core.bytes : null,
        post: state.actual.post ? state.actual.post.bytes : null,
      },
      evidence: state.evidence,
      override: state.override,
    });
    return state.evidence.matched ? 0 : 1;
  }
  console.log(`当前越狱 : ${label}`);
  console.log(`配置     : enabled=${eff.enabled}  promptSet=${eff.promptSet}  tail=${eff.tail}`);
  console.log(
    `期望三段 : pre ${state.expected.pre.bytes} B ｜ core ${state.expected.core.bytes} B ｜ post ${state.expected.post.bytes} B`,
  );
  console.log(
    `快照实际 : pre ${state.actual.pre ? state.actual.pre.bytes : "缺失"} B ｜ core ${state.actual.core ? state.actual.core.bytes : "缺失"} B ｜ post ${state.actual.post ? state.actual.post.bytes : "缺失"} B`,
  );
  console.log(`证据     : ${state.evidence.summary}`);
  console.log(`override : ${state.override ? JSON.stringify(state.override) : "(无，走 cordis.patch.yml)"}`);
  return state.evidence.matched ? 0 : 1;
}

function statusCommand() {
  const { config, core, probes } = probeSummary();
  const payload = {
    name: "bingbing",
    version: PKG.version,
    stateRoot: stateRoot(),
    configUsed: config,
    promptSet: core.set,
    degraded: core.degraded,
    core: { fp: core.fp, role: core.role, bytes: core.bytes, sha256: core.sha256 },
    status: readJson(path.join(stateRoot(), "status.json"), null),
    probes,
  };
  if (json) {
    print(payload);
    return 0;
  }
  console.log(`version    : ${payload.version}`);
  console.log(`state root : ${payload.stateRoot}`);
  console.log(`promptSet  : ${payload.promptSet}${payload.degraded ? ` (degraded: ${payload.degraded})` : ""}`);
  console.log(`core       : ${payload.core.bytes} B  ${payload.core.role}  ${String(payload.core.sha256).slice(0, 12)}`);
  renderProbes(probes);
  return probes.summary.verdict === "PASS" ? 0 : 1;
}

/* ── update ───────────────────────────────────────────────────────────── */

async function updateCommand() {
  try {
    return await updateCommandInner();
  } catch (e) {
    console.error(`\n  ✗ ${(e && e.message) || e}\n`);
    if (/HTTP 404/.test(String(e && e.message))) {
      console.error("  提示：仓库现在是私有的。要么把仓库设回 public，要么：");
      console.error("        node bin\\bingbing.js update token <read-only PAT>");
      console.error("        （PAT 只存在 ~/.dsh/state/bingbing/github-token.txt，不进任何配置文件）\n");
    }
    return 1;
  }
}

async function updateCommandInner() {
  // 先摘掉 --force / --json 这类开关，再按位置取子命令与目标：
  // 否则 `update install --force latest` 会把 "--force" 当成版本号。
  const rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const sub = rest[0] || "status";
  const target = rest[1] || null;
  const force = argv.includes("--force");

  if (sub === "status") {
    const s = updateStatus();
    if (json) {
      print(s);
      return 0;
    }
    step("版本库");
    console.log(`  目录     : ${s.paths.versions}`);
    console.log(`  当前生效 : ${s.active ?? "（未设置）"}${s.running ? `　运行中 ${s.running}` : ""}`);
    if (s.pending) console.log(`  待确认   : ${s.pending.from} → ${s.pending.to}（重启后 60 秒自检，不过会自动回滚）`);
    if (s.rollbackNeeded) {
      console.log(`  ! 上次回滚 : ${s.rollbackNeeded.from} → ${s.rollbackNeeded.to}（${s.rollbackNeeded.reason}）`);
    }
    console.log(`  重启脚本 : ${s.restart.path}${s.restart.exists ? "（已存在，双击即重启）" : "（尚未生成：update restart）"}`);
    console.log(`  私有仓凭证: ${s.tokenConfigured ? "已配置" : "无（公开仓不需要；私有仓用 update token <PAT>）"}`);
    if (!s.versions.length) {
      console.log("  （还没有装过任何版本：node bin\\bingbing.js update install latest）");
    } else {
      console.log("");
      console.log(`  ${"版本".padEnd(12)}${"来源".padEnd(22)}安装时间`);
      for (const v of s.versions) {
        console.log(`  ${v.active ? "▸ " : "  "}${v.ver.padEnd(10)}${String(v.source).padEnd(22)}${v.installedAt ? new Date(v.installedAt).toLocaleString() : "-"}`);
      }
    }
    console.log("");
    return 0;
  }

  if (sub === "check") {
    const result = await updateCheck({}, { force: true });
    if (json) {
      print(result);
      return 0;
    }
    step(`检查更新（${result.repo}）`);
    if (!result.rows.length) {
      console.log("  远端没有可安装的 release（上传一个带 .tgz 资产的 release 就有了）");
      return 1;
    }
    console.log(`  ${"版本".padEnd(12)}${"发布".padEnd(22)}${"tgz".padEnd(10)}状态`);
    for (const row of result.rows) {
      const kb = `${Math.round((row.asset.size || 0) / 1024)} KB`;
      const state = row.active ? "当前" : row.installed ? "已装" : "可装";
      console.log(`  ${row.version.padEnd(12)}${String(row.publishedAt || "").slice(0, 19).padEnd(22)}${kb.padEnd(10)}${state}`);
    }
    console.log("");
    console.log(`  最新：${result.latest ?? "?"}　当前：${result.active ?? "?"}${result.updateAvailable ? "　→ 有新版" : "　→ 已是最新"}`);
    console.log("");
    return 0;
  }

  if (sub === "install") {
    let version = target;
    if (!version || version === "latest") {
      const result = await updateCheck({}, { force: true });
      version = result.latest;
      if (!version) {
        console.error("远端没有可安装的版本");
        return 1;
      }
    }
    step(`安装 ${version}${force ? "（--force：允许覆盖正在生效的版本）" : ""}`);
    const record = await updateInstall({}, version, { force });
    ok(`${record.ver} 已解包（${record.files} 文件，${Math.round(record.bytes / 1024)} KB，源 ${record.source}）`);
    console.log(`\n  激活：node bin\\bingbing.js update switch ${record.ver}\n`);
    return 0;
  }

  if (sub === "switch") {
    if (!target) {
      console.error("用法：bingbing update switch <版本>");
      return 2;
    }
    const result = updateSwitch(target);
    step(`切到 ${target}`);
    ok(`current → ${result.to}（原 ${result.from ?? "无"}）`);
    ok(`重启脚本：${result.restart.path}${result.restart.exe ? `（exe ${result.restart.exe}）` : "（没找到 exe，脚本会提示手动打开）"}`);
    console.log("\n  双击 restart.cmd，或托盘退出后重新打开；启动 60 秒内探针不过会自动回滚。\n");
    return 0;
  }

  if (sub === "rollback") {
    const result = updateRollback("cli");
    step("回滚");
    ok(`${result.from} → ${result.to}（${result.reason}）`);
    console.log("\n  重启宿主后生效。\n");
    return 0;
  }

  if (sub === "restart") {
    const result = writeRestartScript();
    ok(`restart.cmd：${result.path}${result.exe ? `（exe ${result.exe}）` : "（没找到 exe，脚本会提示手动打开）"}`);
    return 0;
  }

  if (sub === "token") {
    if (!target) {
      const stored = readStoredToken();
      console.log(`\n  私有仓 token：${stored ? `已配置（${stored.slice(0, 4)}…${stored.slice(-4)}）` : "未配置"}`);
      console.log("  用法：node bin\\bingbing.js update token <PAT>   （传空字符串清除）\n");
      return 0;
    }
    const file = writeToken(target === "clear" ? "" : target);
    ok(file ? `token 已写入 ${file}` : "token 已清除");
    return 0;
  }

  console.error(`未知子命令：${sub}（可用 status / check / install / switch / rollback / restart）`);
  return 2;
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

if (wantsHelp) {
  process.stdout.write(USAGE);
  process.exitCode = 0;
} else {
  try {
    switch (command) {
      case "install":
        install();
        break;
      case "uninstall":
        uninstall();
        break;
      case "doctor":
        process.exitCode = doctor();
        break;
      case "which":
        process.exitCode = which();
        break;
      case "status":
        process.exitCode = statusCommand();
        break;
      case "check": {
        const { probes } = probeSummary();
        if (json) print(probes);
        else renderProbes(probes);
        process.exitCode = probes.summary.verdict === "PASS" ? 0 : 1;
        break;
      }
      case "paths": {
        const { core } = probeSummary();
        print({
          stateRoot: stateRoot(),
          statusFile: path.join(stateRoot(), "status.json"),
          lastAssembly: path.join(stateRoot(), "last-assembly.json"),
          filteredLog: path.join(stateRoot(), "filtered.jsonl"),
          promptCore: core.fp,
          profileDir: PROFILE_DIR,
        });
        break;
      }
      case "update":
        updateCommand().then((code) => {
          process.exitCode = code;
        });
        break;
      default:
        process.stdout.write(USAGE);
        process.exitCode = 2;
    }
  } catch (e) {
    console.error(`\n失败：${(e && e.message) || e}\n`);
    process.exitCode = 1;
  }
}
