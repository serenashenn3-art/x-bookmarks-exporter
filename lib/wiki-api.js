/**
 * lib/wiki-api.js — LLM Wiki 本地知识库 API 客户端 + 深度内容分流判定
 * 纯 ES Module：判定/归一化函数不依赖 chrome API（可被 Node 测试引用）；
 * WikiAPI 仅使用 fetch / AbortController，background / options 均可直接调用。
 *
 * 本地 LLM Wiki 服务约定（HTTP）：
 *   GET  {baseUrl}/api/health           → { ok: true, version: "x.y.z" }
 *   POST {baseUrl}/api/pages            → { ok: true, pageUrl: "http://..." }
 *       body: 见 buildWikiPagePayload；服务端按 externalId 去重
 */

import { DEFAULT_WIKI_CONFIG, WIKI_AUTO_SYNC_MODES, NATURES, ACTIONS } from "./constants.js";

/** 推送到 Wiki 的正文最大长度（超出截断，保留核心内容） */
export const WIKI_MAX_CONTENT_LENGTH = 8000;

/** 归一化 Wiki 配置：缺字段补默认、非法值回退 */
export function normalizeWikiConfig(raw) {
  const d = DEFAULT_WIKI_CONFIG;
  const cfg = (raw && typeof raw === "object" ? raw : {});
  const autoSync = WIKI_AUTO_SYNC_MODES.includes(cfg.autoSync) ? cfg.autoSync : d.autoSync;
  // 合法枚举过滤；非数组（未配置）用默认，显式空数组保留（用户全部取消勾选是合法的）
  const pickList = (val, allowed, def) =>
    Array.isArray(val) ? val.filter((v) => allowed.includes(v)) : [...def];
  const minTextLength = Number.isFinite(+cfg.minTextLength)
    ? Math.min(5000, Math.max(100, Math.round(+cfg.minTextLength)))
    : d.minTextLength;
  return {
    enabled: cfg.enabled === true,
    baseUrl: (typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : d.baseUrl).replace(/\/+$/, ""),
    autoSync,
    deepNatures: pickList(cfg.deepNatures, NATURES, d.deepNatures),
    minTextLength,
    autoActions: pickList(cfg.autoActions, ACTIONS, d.autoActions),
  };
}

/**
 * 判定一条书签是否为"深度内容"：
 * Nature 命中配置列表，或正文长度超过阈值。
 */
export function isDeepContent(tweet, wikiConfig) {
  const cfg = wikiConfig || DEFAULT_WIKI_CONFIG;
  if ((cfg.deepNatures || []).includes(tweet?.nature)) return true;
  return (tweet?.content || "").trim().length >= (cfg.minTextLength ?? 500);
}

/**
 * 分类完成后的分流决策：
 * - Wiki 未启用 / manual → "light"（用户可手动推送）
 * - smart + 深度 → "pending"（待用户确认）
 * - auto + 深度 → "deep"（由调用方自动推送）
 * - 其余 → "light"
 */
export function routeProcessingMode(tweet, wikiConfig) {
  const cfg = wikiConfig || DEFAULT_WIKI_CONFIG;
  if (!cfg.enabled || cfg.autoSync === "manual") return "light";
  if (!isDeepContent(tweet, cfg)) return "light";
  return cfg.autoSync === "auto" ? "deep" : "pending";
}

/** 组装 POST /api/pages 的请求体（服务端按 externalId 去重；正文超长截断） */
export function buildWikiPagePayload(tweet) {
  let content = tweet.content || "";
  if (content.length > WIKI_MAX_CONTENT_LENGTH) content = content.slice(0, WIKI_MAX_CONTENT_LENGTH) + "\n…（正文过长已截断）";
  return {
    source: "x-bookmarks-exporter",
    externalId: String(tweet.id),
    title: (tweet.summary || content.split("\n")[0] || "无标题").slice(0, 120),
    content,
    url: tweet.url || "",
    author: tweet.author?.name || "",
    authorHandle: tweet.author?.handle || "",
    publishedAt: tweet.publishedAt || "",
    category: tweet.category || "",
    nature: tweet.nature || "",
    contentType: tweet.contentType || "文字",
    tags: Array.isArray(tweet.tags) ? tweet.tags : [],
    summary: tweet.summary || "",
    note: tweet.note || "",
    images: Array.isArray(tweet.images) ? tweet.images : [],
  };
}

/** LLM Wiki 本地服务客户端 */
export class WikiAPI {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || DEFAULT_WIKI_CONFIG.baseUrl).replace(/\/+$/, "");
  }

  async #fetch(path, options = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(this.baseUrl + path, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 测试连接：成功 { ok: true, version }；失败 { ok: false, error }（不抛错） */
  async testConnection() {
    try {
      const res = await this.#fetch("/api/health", {}, 5000);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json().catch(() => ({}));
      return { ok: true, version: data.version || "unknown" };
    } catch (e) {
      const hint = e.name === "AbortError" ? "连接超时" : "服务未启动或地址不可达";
      return { ok: false, error: `${hint}（${e.message}）` };
    }
  }

  /**
   * 推送单条书签到 Wiki。
   * 429 限流时指数退避重试（1s / 2s / 4s）；其他失败直接抛错。
   * 成功返回 { pageUrl }。
   */
  async pushPage(tweet) {
    const body = JSON.stringify(buildWikiPagePayload(tweet));
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.#fetch("/api/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.status === 429) {
          lastErr = new Error("API 限流（429）");
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        return { pageUrl: data.pageUrl || null };
      } catch (e) {
        if (e.name === "AbortError") throw new Error("推送超时");
        lastErr = e;
        break; // 非限流错误不重试
      }
    }
    throw lastErr || new Error("推送失败");
  }
}
