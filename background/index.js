/**
 * background/index.js — MV3 Service Worker（ES Module）
 * AI 分类引擎：内存队列串行处理，每条间隔 ≥500ms 防限流；
 * 队列状态持久化到 chrome.storage.session，SW 被终止后唤醒可继续。
 */

import { DEFAULT_CLASSIFICATION } from "../lib/constants.js";
import { buildClassificationPrompt, buildGroupSummaryPrompt, extractJson, normalizeClassification } from "../lib/prompt.js";
import { callAI, testConnection, normalizeAiConfig } from "../lib/ai-providers.js";
import { buildExport } from "../lib/export.js";
import { stripOembedHtml, matchesRead } from "../lib/media.js";
import {
  getAiConfig,
  getAllTweets,
  getTweet,
  saveTweets,
  updateTweet,
  deleteTweet,
  clearAllTweets,
  migrateLegacy,
} from "../lib/storage.js";

const QUEUE_KEY = "xb_queue_state";
const CLASSIFY_INTERVAL_MS = 500;
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
  try {
    while (queue.length) {
      const id = queue[0];
      const done = queueTotal - queue.length;
      broadcast({ action: "classifyProgress", done, total: queueTotal, currentId: id });

      await classifyOne(id);

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

  try {
    const config = await getAiConfig();
    const text = await callAI(config, buildClassificationPrompt(tweet), {
      maxTokens: 512,
      jsonMode: true,
    });
    const patch = normalizeClassification(extractJson(text), tweet);
    const updated = await updateTweet(id, patch);
    broadcast({ action: "tweetClassified", tweet: updated });
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
      if (r.added > 0 && message.autoClassify !== false) {
        const ids = message.tweets.map((t) => t.id);
        enqueue(ids);
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
      return updated ? { success: true, tweet: updated } : { success: false, error: "推文不存在" };
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

migrateLegacy().then(() => restoreQueue()).catch(() => {});
