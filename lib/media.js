/**
 * lib/media.js — 媒体/正文相关的纯逻辑（不依赖 chrome API，可被 background / Node 测试引用）
 *
 * 注意：content/scraper.js 是 classic script 无法 import，
 * 其中 upgradeImageUrl / detectContentType 有内联同步副本，改动时请两边同步。
 */

/** 解码常见 HTML 实体（oEmbed 返回的 html 字段里含 &amp; &mdash; 等） */
function decodeEntities(s) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    mdash: "—", ndash: "–", hellip: "…", nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1]?.toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[ent] ?? m;
  });
}

/**
 * 剥掉 publish.twitter.com/oEmbed 返回 html 字段的 HTML 标签，得到纯文本正文。
 * 结构形如：<blockquote class="twitter-tweet"><p>正文…</p>&mdash; Name (@handle) <a>Date</a></blockquote>
 * 附带去掉尾部「— 作者名 (@handle) 日期」署名行。
 */
export function stripOembedHtml(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // 去掉尾部署名行：— Name (@handle) August 20, 2026
  s = s.replace(/\s*[—–-]\s*[^\n]*\(@[\w]+\)[^\n]*$/, "");
  return s.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 把 pbs.twimg.com 图片 URL 的尺寸参数替换为原图（name=large）。
 * 非 pbs.twimg.com 的 URL 原样返回。
 */
export function upgradeImageUrl(url) {
  if (!url || typeof url !== "string" || !url.includes("pbs.twimg.com")) return url || "";
  if (/([?&])name=/.test(url)) return url.replace(/([?&])name=[^&]*/, "$1name=large");
  return url + (url.includes("?") ? "&" : "?") + "name=large";
}

/**
 * 依据 DOM 特征判定内容类型（优先级：文章 > 视频 > 图片 > 文字）。
 * @param {{hasVideo?: boolean, imageCount?: number, isArticle?: boolean}} feats
 * @returns {"文章"|"视频"|"图片"|"文字"}
 */
export function detectContentType({ hasVideo = false, imageCount = 0, isArticle = false } = {}) {
  if (isArticle) return "文章";
  if (hasVideo) return "视频";
  if (imageCount > 0) return "图片";
  return "文字";
}

/**
 * 已读状态过滤：readFilter 为 "read" / "unread"，其余（含 ""/"all"）不过滤。
 */
export function matchesRead(tweet, readFilter) {
  if (readFilter === "read") return !!tweet.read;
  if (readFilter === "unread") return !tweet.read;
  return true;
}
