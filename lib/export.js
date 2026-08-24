/**
 * lib/export.js — 多格式导出内容生成（Markdown / JSON / CSV）
 * 纯 ES Module，不依赖 chrome API；下载动作由 background 通过 chrome.downloads 完成。
 */

import { UNCATEGORIZED } from "./constants.js";

const fmtDate = (t) => (t.publishedAt || "").slice(0, 10) || "未知日期";
const authorName = (t) => t.author?.name || "未知作者";
const authorHandle = (t) => t.author?.handle || "";

/** 按维度（category / nature / action）分组，保持输入顺序内的时间倒序由调用方保证 */
function groupBy(tweets, dim) {
  const groups = new Map();
  for (const t of tweets) {
    const key = t[dim] || UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return groups;
}

/** Markdown：按领域分组为二级标题，每条含摘要、作者、日期、标签、原文链接 */
export function toMarkdown(tweets) {
  const groups = groupBy(tweets, "category");
  const parts = [
    `# X 书签导出`,
    ``,
    `*导出于 ${new Date().toLocaleString()}，共 ${tweets.length} 条*`,
  ];
  for (const [category, items] of groups) {
    parts.push(``, `## ${category}（${items.length}）`);
    for (const t of items) {
      const tags = (t.tags || []).map((tag) => `\`#${tag}\``).join(" ");
      parts.push(
        ``,
        `### ${t.summary || (t.content || "").slice(0, 50)}`,
        ``,
        `- 作者：${authorName(t)} (${authorHandle(t)})`,
        `- 日期：${fmtDate(t)}`,
        `- 性质：${t.nature || UNCATEGORIZED} ｜ 建议：${t.action || "-"}`,
        tags ? `- 标签：${tags}` : null,
        `- 原文：${t.url}`
      );
    }
  }
  return parts.filter((l) => l !== null).join("\n");
}

/** JSON：完整字段数组 */
export function toJSON(tweets) {
  return JSON.stringify(tweets, null, 2);
}

function csvEscape(val) {
  const s = String(val ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ");
  return `"${s}"`;
}

/** CSV：表头 ID、作者、正文、摘要、领域、性质、标签、建议操作、日期、链接；标签分号分隔 */
export function toCSV(tweets) {
  const headers = ["ID", "作者", "正文", "摘要", "领域", "性质", "标签", "建议操作", "日期", "链接"];
  const rows = tweets.map((t) =>
    [
      t.id,
      `${authorName(t)} ${authorHandle(t)}`.trim(),
      t.content || "",
      t.summary || "",
      t.category || "",
      t.nature || "",
      (t.tags || []).join(";"),
      t.action || "",
      fmtDate(t),
      t.url || "",
    ]
      .map(csvEscape)
      .join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

export function buildExport(tweets, format) {
  const date = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    return { content: toJSON(tweets), mimeType: "application/json", filename: `x-bookmarks-${date}.json` };
  }
  if (format === "csv") {
    // 加 BOM 以便 Excel 正确识别 UTF-8 中文
    return { content: "﻿" + toCSV(tweets), mimeType: "text/csv", filename: `x-bookmarks-${date}.csv` };
  }
  return { content: toMarkdown(tweets), mimeType: "text/markdown", filename: `x-bookmarks-${date}.md` };
}
