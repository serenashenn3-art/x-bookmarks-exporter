/**
 * lib/prompt.js — 统一分类 Prompt 模板与 AI 响应解析容错
 * 纯 ES Module，不依赖 chrome API。
 */

import {
  CATEGORIES,
  NATURES,
  ACTIONS,
  UNCATEGORIZED,
  DEFAULT_CLASSIFICATION,
} from "./constants.js";

/**
 * 构建单条推文分类 Prompt（固定 JSON 输出）。
 * @param {{content:string, author?:{name?:string, handle?:string}, publishedAt?:string}} tweet
 * @returns {Array<{role:string, content:string}>} chat messages
 */
export function buildClassificationPrompt(tweet) {
  const system = [
    "你是一个精准的推文内容分类器。请根据给定推文输出且仅输出一个 JSON 对象，不要输出任何其他文字或 markdown 代码块标记。",
    "JSON 字段定义：",
    `- "category": 领域，必须从这个列表中选一个：${JSON.stringify(CATEGORIES)}`,
    `- "nature": 内容性质，必须从这个列表中选一个：${JSON.stringify(NATURES)}`,
    '- "tags": 3-5 个简短关键词标签（数组）',
    '- "summary": 一句话摘要，不超过 50 字，使用与推文相同的语言',
    `- "action": 建议操作，必须从这个列表中选一个：${JSON.stringify(ACTIONS)}`,
    '输出格式示例：{"category":"AI/技术","nature":"工具资源","tags":["llm","开源"],"summary":"...","action":"可试用"}',
  ].join("\n");

  const author = tweet.author?.handle || tweet.author?.name || "未知作者";
  const content = (tweet.content || "").slice(0, 800);
  const user = `作者: ${author}\n推文内容:\n${content || "(无正文，可能为纯媒体推文)"}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 构建组内聚合摘要 Prompt（分类汇总视图"生成组内摘要"）。
 * @param {Array} tweets 同组推文
 * @param {string} groupName 组名
 * @returns {Array<{role:string, content:string}>}
 */
export function buildGroupSummaryPrompt(tweets, groupName) {
  const lines = tweets
    .slice(0, 30)
    .map((t, i) => `[${i + 1}] ${t.author?.handle || ""}: ${(t.summary || t.content || "").slice(0, 200)}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是一个内容聚合助手。把同一分类下的多条推文摘要聚合为一张汇总卡片：一段话总览（不超过 120 字）+ 3-6 条要点。用 markdown 列表输出要点，不要输出 JSON。",
    },
    { role: "user", content: `分类组「${groupName}」共 ${tweets.length} 条：\n${lines}` },
  ];
}

/**
 * 容错提取 AI 响应中的 JSON：
 * 1. 去除 markdown 代码块标记
 * 2. 截取最外层 {...}
 * 3. 修复尾逗号后再解析
 */
export function extractJson(text) {
  let cleaned = (text || "").trim();
  if (!cleaned) throw new Error("AI 返回为空");

  // 去除 ```json ... ``` 代码块标记
  cleaned = cleaned.replace(/```(?:json)?/gi, "").trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // 尾逗号容错：{"a":1,} -> {"a":1}
    return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
  }
}

/**
 * 将 AI 返回的原始对象清洗为合法分类结果；任何字段缺失/非法都给默认值。
 * @param {object|null} raw AI 返回解析出的对象
 * @param {object} [tweet] 原始推文（用于兜底摘要）
 */
export function normalizeClassification(raw, tweet) {
  const fallback = { ...DEFAULT_CLASSIFICATION };
  if (!raw || typeof raw !== "object") return fallback;

  const pick = (val, allowed, def) =>
    typeof val === "string" && allowed.includes(val) ? val : def;

  let summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length > 60) summary = summary.slice(0, 57) + "...";
  if (!summary && tweet?.content) summary = tweet.content.slice(0, 50);

  let tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()).slice(0, 5)
    : [];

  return {
    category: pick(raw.category, CATEGORIES, UNCATEGORIZED),
    nature: pick(raw.nature, NATURES, UNCATEGORIZED),
    tags,
    summary,
    action: pick(raw.action, ACTIONS, DEFAULT_CLASSIFICATION.action),
    classifiedAt: Date.now(),
  };
}
