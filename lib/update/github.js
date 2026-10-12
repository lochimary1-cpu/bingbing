import { readJson, stateRoot, writeJson } from "../core/state.js";
import path from "node:path";

/**
 * 更新源：GitHub Releases（公开仓，免 token）。
 *
 * 私有仓也能用：config.updateToken 或环境变量 GITHUB_TOKEN 会给请求带上 Authorization；
 * release 资产在私有仓下必须走 API 端点（browser_download_url 不带 token 会 404），
 * 所以下载统一用 assets[].url + Accept: application/octet-stream。
 */

export const DEFAULT_REPO = "lochimary1-cpu/bingbing";
const API = "https://api.github.com";
const CACHE_MS = 5 * 60 * 1000;

const cachePath = () => path.join(stateRoot(), "update-cache.json");

function headers(token) {
  const base = {
    "User-Agent": "bingbing-updater",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/** 把 tag 归一化成版本号：v0.10.0 / 0.10.0 / release-0.10.0 都成。 */
export function tagToVersion(tag) {
  const match = String(tag || "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)/);
  return match ? match[1] : null;
}

/**
 * 拉 release 列表（带 5 分钟缓存；失败时回落到旧缓存）。
 * @param {{repo?: string, token?: string, force?: boolean}} options
 */
export async function listReleases(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const cached = readJson(cachePath(), null);
  const fresh = cached && cached.repo === repo && Date.now() - Date.parse(cached.at || 0) < CACHE_MS;
  if (fresh && !options.force) return { ...cached, cached: true };

  const response = await fetch(`${API}/repos/${repo}/releases?per_page=30`, { headers: headers(options.token) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // 5xx 才回落到旧缓存；401/403/404 必须把原因抛上去，否则界面会拿着旧缓存
    // 显示"有新版本"，点下去再 404（2026-10-24 就踩过这个坑）。
    if (cached && cached.repo === repo && response.status >= 500) {
      return { ...cached, stale: true, error: `HTTP ${response.status}` };
    }
    const hint =
      response.status === 404
        ? `仓库 ${repo} 不存在，或已转为私有。公开仓可直接更新；私有仓要么设回公开，要么给一个 read-only token（存 state/bingbing/github-token.txt，或环境变量 BINGBING_UPDATE_TOKEN）。`
        : response.status === 401 || response.status === 403
          ? "token 无效、过期，或没有该仓库的读取权限。"
          : "";
    throw new Error(`拉取 release 失败：HTTP ${response.status}。${hint} ${detail.slice(0, 120)}`.trim());
  }
  const releases = await response.json();
  const payload = {
    at: new Date().toISOString(),
    repo,
    releases: (Array.isArray(releases) ? releases : []).map((release) => ({
      tag: release.tag_name,
      version: tagToVersion(release.tag_name),
      name: release.name || release.tag_name,
      publishedAt: release.published_at,
      prerelease: Boolean(release.prerelease),
      notes: String(release.body || "").slice(0, 4000),
      assets: (release.assets || []).map((asset) => ({
        name: asset.name,
        size: asset.size,
        url: asset.url,
        contentType: asset.content_type,
        downloadCount: asset.download_count,
      })),
    })),
  };
  writeJson(cachePath(), payload);
  return payload;
}

/** 在 release 里挑更新用的 .tgz 资产（优先名字带 -dist 或纯版本号的那种）。 */
export function pickTgz(release) {
  const assets = (release?.assets || []).filter((asset) => /\.tgz$/i.test(asset.name));
  if (!assets.length) return null;
  return (
    assets.find((asset) => /-dist\.tgz$/i.test(asset.name)) ||
    assets.find((asset) => !/portable/i.test(asset.name)) ||
    assets[0]
  );
}

/** 下载资产到 Buffer（私有仓走 API 端点 + octet-stream）。 */
export async function downloadAsset(asset, options = {}) {
  const response = await fetch(asset.url, {
    headers: { ...headers(options.token), Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`下载 ${asset.name} 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (asset.size && buffer.length !== asset.size) {
    throw new Error(`下载不完整：期望 ${asset.size} B，实际 ${buffer.length} B`);
  }
  return buffer;
}

/** 归一化后的可安装列表（只保留能装进版本库的）。 */
export async function listInstallable(options = {}) {
  const payload = await listReleases(options);
  return {
    ...payload,
    items: (payload.releases || [])
      .filter((release) => release.version && pickTgz(release))
      .map((release) => ({
        version: release.version,
        tag: release.tag,
        publishedAt: release.publishedAt,
        prerelease: release.prerelease,
        notes: release.notes,
        asset: pickTgz(release),
      })),
  };
}
