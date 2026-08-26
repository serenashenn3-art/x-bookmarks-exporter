/**
 * lib/storage.js — 数据存储层（依赖 chrome.storage，仅供 background / popup / options 使用）
 *
 * - chrome.storage.local 存书签：以推文 ID 为键单条存储（"tweet:<id>"），
 *   另维护索引 "xb_tweet_index"（id 数组，新→旧）
 * - chrome.storage.sync 存 AI 配置（"xb_ai_config"）
 * - migrateLegacy()：兼容旧版 xbe_tweets 数组数据，并给缺字段的旧数据补默认分类与新字段（已读/备注/内容类型等）
 */

import { DEFAULT_CLASSIFICATION, DEFAULT_TWEET_FIELDS } from "./constants.js";
import { normalizeAiConfig } from "./ai-providers.js";

export const TWEET_PREFIX = "tweet:";
export const INDEX_KEY = "xb_tweet_index";
export const AI_CONFIG_KEY = "xb_ai_config";
const LEGACY_KEY = "xbe_tweets";

// ==================== AI 配置（sync） ====================

export async function getAiConfig() {
  const r = await chrome.storage.sync.get(AI_CONFIG_KEY);
  return normalizeAiConfig(r[AI_CONFIG_KEY]);
}

export async function saveAiConfig(config) {
  await chrome.storage.sync.set({ [AI_CONFIG_KEY]: normalizeAiConfig(config) });
}

// ==================== 书签（local，单条存储） ====================

async function getIndex() {
  const r = await chrome.storage.local.get(INDEX_KEY);
  return Array.isArray(r[INDEX_KEY]) ? r[INDEX_KEY] : [];
}

export async function getTweet(id) {
  const r = await chrome.storage.local.get(TWEET_PREFIX + id);
  return r[TWEET_PREFIX + id] || null;
}

/** 返回全部书签，按索引顺序（新→旧） */
export async function getAllTweets() {
  const index = await getIndex();
  if (!index.length) return [];
  const keys = index.map((id) => TWEET_PREFIX + id);
  const r = await chrome.storage.local.get(keys);
  return index.map((id) => r[TWEET_PREFIX + id]).filter(Boolean);
}

/**
 * 批量保存新书签，返回 { added, updated, total }。
 * - 新推文：入库
 * - 已存在但内容类字段缺失的旧记录（如旧版抓的文章无正文）：用新数据补全
 *   content/images/mediaType/contentType/truncated，保留已有分类结果，
 *   并放入 updated 供调用方决定是否重新分类
 */
export async function saveTweets(tweets) {
  if (!Array.isArray(tweets) || !tweets.length) return { added: 0, addedIds: [], updated: [], total: (await getIndex()).length };
  const index = await getIndex();
  const existing = new Set(index);
  const toSet = {};
  const addedIds = [];
  const updated = [];

  // 预先读出可能需要补全的已有记录
  const existKeys = tweets.filter((t) => t?.id && existing.has(t.id)).map((t) => TWEET_PREFIX + t.id);
  const oldRecords = existKeys.length ? await chrome.storage.local.get(existKeys) : {};

  for (const t of tweets) {
    if (!t?.id) continue;
    const key = TWEET_PREFIX + t.id;
    if (!existing.has(t.id)) {
      toSet[key] = {
        ...DEFAULT_TWEET_FIELDS,
        ...DEFAULT_CLASSIFICATION,
        ...t,
        tags: t.tags || [],
        images: Array.isArray(t.images) ? t.images : [],
      };
      index.push(t.id);
      existing.add(t.id);
      addedIds.push(t.id);
      continue;
    }
    // 已有记录：只补内容类字段，不动分类/备注/已读
    const old = oldRecords[key];
    if (!old) continue;
    const patch = {};
    const oldContent = (old.content || "").trim();
    // 旧记录正文只是 oEmbed 链接（文章类常见）：视为待补全，重新入队让后台开页抓全文
    const linkOnly = /^https?:\/\/\S+(\s|$)/.test(oldContent);
    if ((!old.content && t.content) || (linkOnly && t.content && t.content.trim().length > oldContent.length)) {
      patch.content = t.content;
      patch.truncated = !!t.truncated;
    }
    if ((!Array.isArray(old.images) || !old.images.length) && Array.isArray(t.images) && t.images.length) {
      patch.images = t.images;
    }
    if (!old.mediaType && t.mediaType) patch.mediaType = t.mediaType;
    if ((!old.contentType || old.contentType === "文字") && t.contentType && t.contentType !== "文字") {
      patch.contentType = t.contentType;
    }
    if (Object.keys(patch).length) {
      toSet[key] = { ...old, ...patch };
      updated.push(t.id);
    } else if ((old.articleFetchFails || 0) < 3) {
      // 内容没变但仍需后台开文章页补全的，入队重新处理（失败 3 次后不再重试）：
      // 1) 正文只是 oEmbed 链接；2) 文章类型但正文过短（含旧版误抓的作者栏噪音）
      const shortJunk = (old.contentType === "文章" || t.contentType === "文章") && oldContent.length > 0 && oldContent.length < 200;
      if (linkOnly || shortJunk) updated.push(t.id);
    }
  }
  if (addedIds.length) toSet[INDEX_KEY] = index;
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  return { added: addedIds.length, addedIds, updated, total: index.length };
}

/** 局部更新单条书签（如 AI 分类结果、拖拽变更 action） */
export async function updateTweet(id, patch) {
  const key = TWEET_PREFIX + id;
  const r = await chrome.storage.local.get(key);
  if (!r[key]) return null;
  const updated = { ...r[key], ...patch };
  await chrome.storage.local.set({ [key]: updated });
  return updated;
}

export async function deleteTweet(id) {
  const index = await getIndex();
  const next = index.filter((x) => x !== id);
  await chrome.storage.local.remove(TWEET_PREFIX + id);
  await chrome.storage.local.set({ [INDEX_KEY]: next });
}

/** 清空全部书签：逐个删除单条键并清空索引，返回删除条数 */
export async function clearAllTweets() {
  const index = await getIndex();
  const keys = index.map((id) => TWEET_PREFIX + id);
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [INDEX_KEY]: [] });
  return index.length;
}

// ==================== 旧数据迁移 ====================

/**
 * 1. 检测旧版 "xbe_tweets" 数组 → 拆为单条键存储后删除旧键
 * 2. 检测缺分类字段的旧数据 → 补默认分类字段
 * 幂等，可每次 SW 启动时调用。
 */
export async function migrateLegacy() {
  // --- 旧数组格式迁移 ---
  const legacy = await chrome.storage.local.get(LEGACY_KEY);
  if (Array.isArray(legacy[LEGACY_KEY]) && legacy[LEGACY_KEY].length) {
    const index = await getIndex();
    const existing = new Set(index);
    const toSet = {};
    for (const t of legacy[LEGACY_KEY]) {
      if (!t?.id || existing.has(t.id)) continue;
      toSet[TWEET_PREFIX + t.id] = { ...DEFAULT_TWEET_FIELDS, ...DEFAULT_CLASSIFICATION, ...t };
      index.push(t.id);
      existing.add(t.id);
    }
    toSet[INDEX_KEY] = index;
    await chrome.storage.local.set(toSet);
    await chrome.storage.local.remove(LEGACY_KEY);
  }

  // --- 缺字段补默认（分类字段 + 媒体/已读/备注等新字段） ---
  const index = await getIndex();
  if (!index.length) return;
  const keys = index.map((id) => TWEET_PREFIX + id);
  const all = await chrome.storage.local.get(keys);
  const patch = {};
  for (const id of index) {
    const t = all[TWEET_PREFIX + id];
    if (!t) continue;
    const missing =
      t.category === undefined ||
      t.nature === undefined ||
      t.action === undefined ||
      !Array.isArray(t.tags) ||
      Object.keys(DEFAULT_TWEET_FIELDS).some((k) => t[k] === undefined);
    if (missing) {
      patch[TWEET_PREFIX + id] = {
        ...DEFAULT_TWEET_FIELDS,
        ...DEFAULT_CLASSIFICATION,
        ...t,
        tags: t.tags || [],
        images: Array.isArray(t.images) ? t.images : [],
      };
    }
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}
