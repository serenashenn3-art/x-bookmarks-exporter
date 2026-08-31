/**
 * lib/wiki-api.js — LLM Wiki 桥接服务 API 客户端 + 深度内容分流判定
 * 纯 ES Module：判定/归一化函数不依赖 chrome API（可被 Node 测试引用）；
 * WikiAPI 仅使用 fetch / AbortController，background / options 均可直接调用。
 *
 * 桥接服务约定（HTTP，参考实现见 bridge/wiki-bridge.mjs）：
 *   GET  {baseUrl}/api/health           → { ok: true, version: "x.y.z", llmReady: bool }
 *   GET  {baseUrl}/api/sinks            → { ok: true, sinks: [{id, label, ...}] }
 *   POST {baseUrl}/api/pages            → { ok: true, pageUrl: "http://..." }
 *       body: 见 buildWikiPagePayload；target 字段选择 sink（缺省走桥接默认）；
 *       服务端按 externalId 去重
 *   POST {baseUrl}/api/llm              → { ok: true }
 *       body: { provider, baseUrl, model, key }；把扩展的 AI 配置同步给桥接，
 *       桥接的自动实体抽取即可复用同一厂商/key，用户无需输入两次
 */

import { DEFAULT_WIKI_CONFIG, WIKI_AUTO_SYNC_MODES, NATURES, ACTIONS } from "./constants.js";

/** 推送到 Wiki 的正文最大长度（超出截断，保留核心内容） */
export const WIKI_MAX_CONTENT_LENGTH = 8000;

/** 桥接端只支持 OpenAI 兼容 /chat/completions：这些 provider 的扩展 AI 配置可以一键同步给桥接 */
export const BRIDGE_LLM_PROVIDERS = ["openai", "kimi", "qwen", "glm", "minimax", "ollama"];

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
    sink: typeof cfg.sink === "string" ? cfg.sink : d.sink, // 桥接服务的 sink id，空 = 桥接默认
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

/** LLM Wiki 桥接服务客户端 */
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

  /** 原始健康检查：成功返回桥接数据 { ok, version, llmReady, ... }；失败返回 null */
  async health() {
    try {
      const res = await this.#fetch("/api/health", {}, 5000);
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  /** 测试连接：成功 { ok: true, version, llmReady }；失败 { ok: false, error }（不抛错） */
  async testConnection() {
    try {
      const res = await this.#fetch("/api/health", {}, 5000);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json().catch(() => ({}));
      return { ok: true, version: data.version || "unknown", llmReady: data.llmReady };
    } catch (e) {
      const hint = e.name === "AbortError" ? "连接超时" : "服务未启动或地址不可达";
      return { ok: false, error: `${hint}（${e.message}）` };
    }
  }

  /**
   * 把扩展的 AI 配置（normalizeAiConfig 结果）同步给桥接服务，
   * 桥接的自动实体抽取即可复用同一厂商/key，用户无需在两端各输一次。
   * 非 OpenAI 兼容 provider（anthropic/gemini）或未填 key 时跳过：{ ok: false, skipped: true }。
   */
  async pushLLMConfig(ai) {
    if (!ai || !BRIDGE_LLM_PROVIDERS.includes(ai.provider)) return { ok: false, skipped: true };
    if (!ai.apiKey && ai.provider !== "ollama") return { ok: false, skipped: true };
    try {
      const res = await this.#fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, key: ai.apiKey }),
      }, 5000);
      const data = await res.json().catch(() => ({}));
      return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 拉取桥接服务可用的 sink 列表（供设置页选择推送目标）；失败返回空数组 */
  async listSinks() {
    try {
      const res = await this.#fetch("/api/sinks", {}, 5000);
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data.sinks) ? data.sinks : [];
    } catch {
      return [];
    }
  }

  /**
   * 推送单条书签到桥接服务。
   * @param {object} tweet 书签对象
   * @param {string} [target] 目标 sink id（缺省走桥接默认 sink）
   * 429 限流时指数退避重试（1s / 2s / 4s）；其他失败直接抛错。
   * 成功返回 { pageUrl }。
   */
  async pushPage(tweet, target) {
    const payload = buildWikiPagePayload(tweet);
    if (target) payload.target = target;
    const body = JSON.stringify(payload);
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
