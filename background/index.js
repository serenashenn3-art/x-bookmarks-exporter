/**
 * background/index.js — MV3 Service Worker（ES Module）
 * AI 分类引擎：内存队列串行处理，每条间隔 ≥500ms 防限流；
 * 队列状态持久化到 chrome.storage.session，SW 被终止后唤醒可继续。
 */

import { DEFAULT_CLASSIFICATION } from "../lib/constants.js";
import { buildClassificationPrompt, buildGroupSummaryPrompt, extractJson, normalizeClassification } from "../lib/prompt.js";
import { callAI, testConnection, normalizeAiConfig } from "../lib/ai-providers.js";
import { WikiAPI, routeProcessingMode } from "../lib/wiki-api.js";
import { buildExport } from "../lib/export.js";
import { stripOembedHtml, matchesRead } from "../lib/media.js";
import {
  getAiConfig,
  getWikiConfig,
  getAllTweets,
  getTweet,
  saveTweets,
  updateTweet,
  deleteTweet,
  clearAllTweets,
  migrateLegacy,
} from "../lib/storage.js";

const QUEUE_KEY = "xb_queue_state";
const WIKI_QUEUE_KEY = "xb_wiki_queue";
const CLASSIFY_INTERVAL_MS = 500;
const WIKI_SYNC_INTERVAL_MS = 300; // 批量推送间隔，防 Wiki 服务过载
const OEMBED_BASE = "https://publish.twitter.com/oembed?url=";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用免鉴权的 publish.twitter.com/oEmbed 接口补全被 X 截断的长推文正文。
 * 成功返回纯文本全文；失败抛错由调用方降级处理。
 */
async function fetchFullText(tweet) {
  const res = await fetch(OEMBED_BASE + encodeURIComponent(tweet.url));
  if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
  const data = await res.json();
  const text = stripOembedHtml(data.html || "");
  if (!text) throw new Error("oEmbed 返回无正文");
  return text;
}

/**
 * 在真实文章页面执行的正文提取（自包含，由 scripting.executeScript 注入）。
 * X 长文（Articles）正文不在 tweetText 里，oEmbed 也只返回链接，必须开页面抓。
 * 只认文章阅读视图，且要求足够长，避免把作者栏/关注按钮等页面噪音当正文。
 */
function extractArticleTextInPage() {
  const root =
    document.querySelector('[data-testid="twitterArticleReadView"]') ||
    document.querySelector('[data-testid="article"]') ||
    document.querySelector('main[role="main"]');
  if (!root) return null;
  const nodes = root.querySelectorAll("h1, h2, h3, p, li, blockquote, [dir='auto'][lang]");
  const picked = [];
  const seen = new Set();
  for (const el of nodes) {
    // 只取叶子级，避免父容器重复整段文本
    if (el.querySelector("h1, h2, h3, p, li, blockquote, [dir='auto'][lang]")) continue;
    // 跳过作者栏 / 按钮 / 站点导航里的文本（保留文章自身 header 中的引语段）
    if (el.closest('[data-testid="User-Name"], [role="button"], button, nav, header[role="banner"]')) continue;
    const text = (el.innerText || "").trim();
    if (text.length < 20 || seen.has(text)) continue;
    if (/^(关注|正在关注|Follow|Following|Subscribe|订阅)$/.test(text)) continue;
    seen.add(text);
    picked.push(text);
  }
  const joined = picked.join("\n\n");
  return joined.length >= 300 ? joined : null; // 太短多半是噪音，宁缺毋滥
}

/** 等标签页加载完成（带竞态处理与超时） */
function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("页面加载超时"));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // 竞态：监听器挂上时页面可能已加载完
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }).catch(() => {});
  });
}

/**
 * 文章类型：后台开一个不可见标签页抓 X Articles 正文。
 * 实测规律：/<handle>/article/<tweetId> 直接打开就是文章阅读页
 * （/i/article/<articleId> 也会重定向到这个形态），无需先进详情页找链接。
 * 成功返回纯文本；失败返回 null（调用方保持现状）。
 */
async function fetchArticleFullText(tweet) {
  let tabId = null;
  try {
    const handle = (tweet.author?.handle || "").replace(/^@/, "");
    if (!handle) return null;
    const articleUrl = `https://x.com/${handle}/article/${tweet.id}`;
    const tab = await chrome.tabs.create({ url: articleUrl, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId);
    await sleep(2500); // 等前端渲染

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractArticleTextInPage,
    });
    return result?.result || null;
  } catch {
    return null;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ==================== 队列（SW 终止可恢复） ====================

let queue = []; // 待分类推文 id
let queueTotal = 0; // 本轮入队总数（进度显示用）
let processing = false;

async function persistQueue() {
  const state = { queue, total: queueTotal };
  try {
    await chrome.storage.session.set({ [QUEUE_KEY]: state });
  } catch {
    await chrome.storage.local.set({ [QUEUE_KEY]: state });
  }
}

async function restoreQueue() {
  let state = null;
  try {
    const r = await chrome.storage.session.get(QUEUE_KEY);
    state = r[QUEUE_KEY];
  } catch { /* fallback */ }
  if (!state) {
    const r = await chrome.storage.local.get(QUEUE_KEY);
    state = r[QUEUE_KEY];
    if (state) await chrome.storage.local.remove(QUEUE_KEY);
  }
  if (state?.queue?.length) {
    queue = state.queue;
    queueTotal = state.total || queue.length;
    processQueue().catch(() => {});
  }
}

async function clearPersistedQueue() {
  try {
    await chrome.storage.session.remove(QUEUE_KEY);
  } catch { /* ignore */ }
  await chrome.storage.local.remove(QUEUE_KEY).catch(() => {});
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // popup 可能未打开
}

async function enqueue(tweetIds) {
  const inQueue = new Set(queue);
  const fresh = tweetIds.filter((id) => !inQueue.has(id));
  if (!fresh.length) return;
  queue.push(...fresh);
  queueTotal += fresh.length;
  await persistQueue();
  processQueue().catch(() => {});
  return fresh.length;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  // 保活：文章全文抓取可能让 SW 空闲超时被杀，周期性 API 调用重置空闲计时
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
  try {
    while (queue.length) {
      const id = queue[0];
      const done = queueTotal - queue.length;
      broadcast({ action: "classifyProgress", done, total: queueTotal, currentId: id });

      try {
        await classifyOne(id);
      } catch (e) {
        // 单条异常不阻塞整条队列
        console.error("classifyOne failed:", id, e);
      }

      queue.shift();
      await persistQueue();
      broadcast({
        action: "classifyProgress",
        done: queueTotal - queue.length,
        total: queueTotal,
        currentId: id,
      });

      if (queue.length) await sleep(CLASSIFY_INTERVAL_MS); // 防限流
    }
  } finally {
    clearInterval(keepAlive);
    processing = false;
    if (!queue.length) {
      queueTotal = 0;
      await clearPersistedQueue();
      broadcast({ action: "classifyProgress", done: 0, total: 0, finished: true });
    }
  }
}

/** 分类单条；AI 失败时降级为默认分类，不阻塞队列 */
async function classifyOne(id) {
  let tweet = await getTweet(id);
  if (!tweet) return;

  // 长推文补全：时间线正文被截断（truncated）时先走 oEmbed 拿全文
  if (tweet.truncated && !tweet.fullTextFailed) {
    try {
      const full = await fetchFullText(tweet);
      tweet = (await updateTweet(id, { content: full, truncated: false })) || tweet;
    } catch {
      await updateTweet(id, { fullTextFailed: true }); // 保持原文，标记补全失败
    }
  }

  // 文章（Articles）：oEmbed 只返回链接，内容为空或只是链接时开后台标签页抓全文
  // 失败计次，最多重试 3 次（代码升级后仍有机会补上，又不会每次抓取都白开标签页）
  const contentTrim = (tweet.content || "").trim();
  const looksLikeOnlyLink =
    /^https?:\/\/\S+(\s|$)/.test(contentTrim) ||
    (tweet.contentType === "文章" && (!contentTrim || contentTrim.length < 200));
  if (looksLikeOnlyLink && (tweet.articleFetchFails || 0) < 3) {
    const full = await fetchArticleFullText(tweet);
    if (full) {
      tweet = (await updateTweet(id, {
        content: full,
        truncated: false,
        contentType: "文章",
        articleFetchFails: 0,
        articleFetchFailed: false,
      })) || tweet;
    } else {
      await updateTweet(id, {
        articleFetchFails: (tweet.articleFetchFails || 0) + 1,
        articleFetchFailed: true,
      });
    }
  }

  try {
    const config = await getAiConfig();
    const text = await callAI(config, buildClassificationPrompt(tweet), {
      maxTokens: 512,
      jsonMode: true,
    });
    const patch = normalizeClassification(extractJson(text), tweet);
    const updated = await updateTweet(id, patch);
    // 分类完成 → 按 Wiki 分流策略决定 light / pending / deep
    await applyWikiRouting(updated);
    broadcast({ action: "tweetClassified", tweet: await getTweet(id) });
  } catch (e) {
    const updated = await updateTweet(id, {
      ...DEFAULT_CLASSIFICATION,
      summary: tweet.summary || (tweet.content || "").slice(0, 50),
      classifiedAt: Date.now(),
      classifyError: e.message,
    });
    broadcast({ action: "tweetClassified", tweet: updated });
  }
}

// ==================== LLM Wiki 同步（队列持久化，SW 终止可恢复） ====================

let wikiQueue = []; // 待推送推文 id
let wikiQueueTotal = 0;
let wikiProcessing = false;
let wikiQueueTarget = ""; // 本批推送的目标 sink id（空 = 扩展设置里的默认 sink）

async function persistWikiQueue() {
  const state = { queue: wikiQueue, total: wikiQueueTotal, target: wikiQueueTarget };
  try {
    await chrome.storage.session.set({ [WIKI_QUEUE_KEY]: state });
  } catch {
    await chrome.storage.local.set({ [WIKI_QUEUE_KEY]: state });
  }
}

async function restoreWikiQueue() {
  let state = null;
  try {
    const r = await chrome.storage.session.get(WIKI_QUEUE_KEY);
    state = r[WIKI_QUEUE_KEY];
  } catch { /* fallback */ }
  if (!state) {
    const r = await chrome.storage.local.get(WIKI_QUEUE_KEY);
    state = r[WIKI_QUEUE_KEY];
    if (state) await chrome.storage.local.remove(WIKI_QUEUE_KEY);
  }
  if (state?.queue?.length) {
    wikiQueue = state.queue;
    wikiQueueTotal = state.total || wikiQueue.length;
    wikiQueueTarget = state.target || "";
    processWikiQueue().catch(() => {});
  }
}

async function clearPersistedWikiQueue() {
  try {
    await chrome.storage.session.remove(WIKI_QUEUE_KEY);
  } catch { /* ignore */ }
  await chrome.storage.local.remove(WIKI_QUEUE_KEY).catch(() => {});
}

async function enqueueWiki(tweetIds, target = "") {
  const inQueue = new Set(wikiQueue);
  const fresh = tweetIds.filter((id) => !inQueue.has(id));
  if (!fresh.length) return 0;
  if (target) wikiQueueTarget = target; // 本批显式指定目标 sink（如 claude/codex/kimi）
  wikiQueue.push(...fresh);
  wikiQueueTotal += fresh.length;
  await persistWikiQueue();
  processWikiQueue().catch(() => {});
  return fresh.length;
}

/**
 * 推送单条到 LLM Wiki，返回 { success, error? }。
 * 按「书签 × 目标 sink」去重（同一书签可分别推多个 sink）；失败把原因写入 wikiSyncError 供卡片展示与重试。
 */
async function syncOneToWiki(id, explicitTarget = "") {
  const tweet = await getTweet(id);
  if (!tweet) return { success: false, error: "推文不存在" };
  const cfg = await getWikiConfig();
  if (!cfg.enabled) return { success: false, error: "LLM Wiki 未启用" };
  const target = explicitTarget || cfg.sink || "";
  // 按目标 sink 去重：同一书签可分别推送到 obsidian / claude / codex 等多个目标
  const sentTo = Array.isArray(tweet.wikiSinks) ? tweet.wikiSinks : [];
  if (sentTo.includes(target)) return { success: true, skipped: true };
  try {
    const api = new WikiAPI(cfg.baseUrl);
    // 桥接端还没配 LLM 时，把扩展的 AI 配置同步过去（key 只需在扩展设置页输一次）；
    // 同步失败（如 anthropic/gemini 不兼容）不阻塞推送，仅自动实体抽取不生效
    const h = await api.health();
    if (h?.ok && h.llmReady === false) {
      const ai = await getAiConfig();
      await api.pushLLMConfig(ai).catch(() => {});
    }
    const { pageUrl } = await api.pushPage(tweet, target);
    const updated = await updateTweet(id, {
      wikiSynced: true,
      wikiSinks: [...sentTo, target],
      wikiPageUrl: pageUrl,
      wikiSyncError: null,
      processingMode: "deep",
    });
    broadcast({ action: "wikiSyncDone", tweet: updated });
    return { success: true };
  } catch (e) {
    const updated = await updateTweet(id, { wikiSyncError: e.message, processingMode: "deep" });
    broadcast({ action: "wikiSyncDone", tweet: updated });
    return { success: false, error: e.message };
  }
}

async function processWikiQueue() {
  if (wikiProcessing) return;
  wikiProcessing = true;
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
  try {
    while (wikiQueue.length) {
      const id = wikiQueue[0];
      broadcast({ action: "wikiSyncProgress", done: wikiQueueTotal - wikiQueue.length, total: wikiQueueTotal });
      try {
        await syncOneToWiki(id, wikiQueueTarget);
      } catch (e) {
        console.error("syncOneToWiki failed:", id, e); // 单条异常不阻塞队列
      }
      wikiQueue.shift();
      await persistWikiQueue();
      broadcast({ action: "wikiSyncProgress", done: wikiQueueTotal - wikiQueue.length, total: wikiQueueTotal });
      if (wikiQueue.length) await sleep(WIKI_SYNC_INTERVAL_MS);
    }
  } finally {
    clearInterval(keepAlive);
    wikiProcessing = false;
    if (!wikiQueue.length) {
      wikiQueueTotal = 0;
      wikiQueueTarget = "";
      await clearPersistedWikiQueue();
      broadcast({ action: "wikiSyncProgress", done: 0, total: 0, finished: true });
    }
  }
}

/** 分类完成后的分流：pending 等用户确认；deep 直接入同步队列；light 不动 */
async function applyWikiRouting(tweet) {
  if (!tweet) return;
  const cfg = await getWikiConfig();
  const mode = routeProcessingMode(tweet, cfg);
  if (mode === "light") return;
  if (mode === "pending") {
    await updateTweet(tweet.id, { processingMode: "pending" });
  } else {
    await updateTweet(tweet.id, { processingMode: "deep" });
    await enqueueWiki([tweet.id]);
  }
}

// ==================== 组内聚合摘要 ====================

async function summarizeGroup(tweetIds, groupName) {
  const all = await getAllTweets();
  const targets = all.filter((t) => tweetIds.includes(t.id));
  if (!targets.length) return { success: false, error: "该组没有推文" };
  try {
    const config = await getAiConfig();
    const text = await callAI(config, buildGroupSummaryPrompt(targets, groupName), {
      maxTokens: 600,
    });
    return { success: true, summary: text.trim() };
  } catch (e) {
    // AI 不可用：拼接各条摘要兜底
    const joined = targets
      .slice(0, 20)
      .map((t, i) => `${i + 1}. ${t.summary || (t.content || "").slice(0, 80)}`)
      .join("\n");
    return { success: true, summary: `（AI 不可用：${e.message}，以下为各条摘要拼接）\n\n${joined}`, fallback: true };
  }
}

// ==================== 查询（搜索 / 筛选 / 排序） ====================

function queryTweets(tweets, filter = {}) {
  let list = tweets;
  if (filter.search) {
    const q = filter.search.toLowerCase();
    list = list.filter(
      (t) =>
        (t.content || "").toLowerCase().includes(q) ||
        (t.author?.name || "").toLowerCase().includes(q) ||
        (t.author?.handle || "").toLowerCase().includes(q) ||
        (t.summary || "").toLowerCase().includes(q) ||
        (t.tags || []).some((tag) => tag.toLowerCase().includes(q))
    );
  }
  if (filter.category) list = list.filter((t) => t.category === filter.category);
  if (filter.nature) list = list.filter((t) => t.nature === filter.nature);
  if (filter.actionFilter) list = list.filter((t) => t.action === filter.actionFilter);
  if (filter.contentType) list = list.filter((t) => (t.contentType || "文字") === filter.contentType);
  list = list.filter((t) => matchesRead(t, filter.readFilter));

  const byTime = (t) => new Date(t.publishedAt || 0).getTime() || t.scrapedAt || 0;
  switch (filter.sort) {
    case "oldest":
      list.sort((a, b) => byTime(a) - byTime(b));
      break;
    case "category":
      list.sort((a, b) => String(a.category || "").localeCompare(String(b.category || ""), "zh"));
      break;
    case "author":
      list.sort((a, b) => String(a.author?.handle || "").localeCompare(String(b.author?.handle || "")));
      break;
    default: // newest
      list.sort((a, b) => byTime(b) - byTime(a));
  }
  return list;
}

// ==================== 导出（SW 无 URL.createObjectURL，用 data URI） ====================

async function handleExport(format, filter) {
  const tweets = queryTweets(await getAllTweets(), filter);
  if (!tweets.length) return { success: false, error: "没有可导出的书签" };
  const { content, mimeType, filename } = buildExport(tweets, format);
  const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
  return { success: true, count: tweets.length, filename };
}

// ==================== 消息路由 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    // content 脚本批量上报
    saveTweets: async () => {
      const r = await saveTweets(message.tweets);
      if (message.autoClassify !== false) {
        // 新增 + 被补全内容的旧记录都入队分类
        const ids = [...(r.addedIds || []), ...(r.updated || [])];
        if (ids.length) enqueue(ids);
      }
      return { success: true, ...r };
    },
    scrapeComplete: async () => {
      broadcast({ action: "scrapeComplete", count: message.count });
      return { success: true };
    },
    getTweets: async () => {
      const all = await getAllTweets();
      return { success: true, tweets: queryTweets(all, message.filter), total: all.length };
    },
    deleteTweet: async () => {
      await deleteTweet(message.tweetId);
      return { success: true };
    },
    clearAll: async () => {
      const removed = await clearAllTweets();
      return { success: true, removed };
    },
    updateNote: async () => {
      const updated = await updateTweet(message.tweetId, {
        note: message.note || "",
        noteUpdatedAt: Date.now(),
      });
      return updated ? { success: true, tweet: updated } : { success: false, error: "推文不存在" };
    },
    markRead: async () => {
      const updated = await updateTweet(message.tweetId, { read: message.read !== false });
      return updated ? { success: true, tweet: updated } : { success: false, error: "推文不存在" };
    },
    updateTweetAction: async () => {
      const updated = await updateTweet(message.tweetId, { action: message.newAction });
      if (!updated) return { success: false, error: "推文不存在" };
      // 看板列自动触发：拖入配置的列且未同步时，自动推送到 LLM Wiki
      const cfg = await getWikiConfig();
      if (cfg.enabled && cfg.autoActions.includes(updated.action) && !updated.wikiSynced) {
        await updateTweet(updated.id, { processingMode: "deep", wikiSyncError: null });
        await enqueueWiki([updated.id]);
      }
      return { success: true, tweet: await getTweet(message.tweetId) };
    },
    reclassify: async () => {
      const ids = message.tweetIds || (await getAllTweets()).map((t) => t.id);
      return { success: true, queued: await enqueue(ids) };
    },
    getProgress: async () => ({
      success: true,
      done: queueTotal - queue.length,
      total: queueTotal,
      processing,
    }),
    summarizeGroup: () => summarizeGroup(message.tweetIds, message.groupName),
    exportTweets: () => handleExport(message.format, message.filter),
    getAiConfig: async () => ({ success: true, config: await getAiConfig() }),
    testConnection: async () => {
      const config = normalizeAiConfig(message.config || {});
      return testConnection(config);
    },
    // === LLM Wiki ===
    getWikiConfig: async () => ({ success: true, config: await getWikiConfig() }),
    testWikiConnection: async () => {
      const cfg = await getWikiConfig();
      return new WikiAPI(message.baseUrl || cfg.baseUrl).testConnection();
    },
    syncToWiki: () => syncOneToWiki(message.tweetId), // 单条：等待结果返回
    batchSyncToWiki: async () => ({ success: true, queued: await enqueueWiki(message.tweetIds || [], message.target || "") }),
    updateWikiStatus: async () => {
      // 仅允许修改 Wiki 相关字段（如 smart 模式拒绝推送：processingMode → light）
      const allow = ["processingMode", "wikiSynced", "wikiPageUrl", "wikiSyncError"];
      const patch = {};
      for (const k of allow) if (k in (message.status || {})) patch[k] = message.status[k];
      const updated = await updateTweet(message.tweetId, patch);
      return updated ? { success: true, tweet: updated } : { success: false, error: "推文不存在" };
    },
    getWikiProgress: async () => ({
      success: true,
      done: wikiQueueTotal - wikiQueue.length,
      total: wikiQueueTotal,
      processing: wikiProcessing,
    }),
    openOptions: async () => {
      chrome.runtime.openOptionsPage();
      return { success: true };
    },
  };

  const handler = handlers[message.action];
  if (!handler) return false;
  handler()
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ success: false, error: e.message }));
  return true; // 异步响应
});

// ==================== 启动：迁移旧数据 + 恢复队列 ====================

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

migrateLegacy().then(() => restoreQueue()).then(() => restoreWikiQueue()).catch(() => {});
