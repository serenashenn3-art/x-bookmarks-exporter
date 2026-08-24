/**
 * content/scraper.js — X 书签自动抓取（content script 不支持 ES module，本文件自包含）
 *
 * 注入 x.com/twitter.com 书签页，右下角「AI 抓取书签」浮动按钮：
 * 点击后循环滚动到底部 → 等待加载 → 扫描推文卡片，直到无新内容；
 * 每批新推文 sendMessage 发给 background；结束后发完成事件并显示数量提示。
 */

(function () {
  "use strict";

  const scrapedIds = new Map(); // 推文 ID -> true（去重）
  let running = false;

  // X 新版将书签并入「历史」页（/i/history，内含书签/喜欢两个标签），旧 /i/bookmarks 会 301 到 /i/history
  const isBookmarksPage = () =>
    location.pathname.includes("/bookmarks") || location.pathname.includes("/i/history");

  // ==================== DOM 提取 ====================

  function findTweetArticles() {
    let articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length) return articles;
    articles = document.querySelectorAll('article[role="article"]');
    return articles;
  }

  function getTextWithLinks(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("a").forEach((a) => {
      const span = document.createElement("span");
      span.textContent = ` ${a.textContent} `;
      a.replaceWith(span);
    });
    return clone.textContent.trim();
  }

  function parseTweet(article) {
    try {
      const timeEl = article.querySelector("a[href*='/status/'] time, time");
      if (!timeEl) return null;
      const timeAnchor = timeEl.closest("a[href*='/status/']");
      if (!timeAnchor) return null;

      const href = timeAnchor.getAttribute("href") || "";
      const idMatch = href.match(/\/status\/(\d+)/);
      const tweetId = idMatch ? idMatch[1] : null;
      if (!tweetId || scrapedIds.has(tweetId)) return null;

      const displayNameEl =
        article.querySelector('[data-testid="User-Name"] a[role="link"] span') ||
        article.querySelector('[data-testid="User-Name"] a') ||
        article.querySelector('a[role="link"] span');
      const displayName = displayNameEl?.textContent?.trim() || "";
      const handleMatch = href.match(/^\/([^/]+)\//);
      const handle = handleMatch ? `@${handleMatch[1]}` : "";

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const content = textEl ? getTextWithLinks(textEl) : "";

      return {
        id: tweetId,
        url: `https://x.com${href}`,
        author: { name: displayName, handle },
        content,
        publishedAt: timeEl.getAttribute("datetime") || "",
        scrapedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** 扫描当前页面，返回新推文数组 */
  function scanTweets() {
    const fresh = [];
    findTweetArticles().forEach((article) => {
      const t = parseTweet(article);
      if (t) {
        scrapedIds.set(t.id, true);
        fresh.push(t);
      }
    });
    return fresh;
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // 扩展上下文失效（重载等）
    }
  }

  // ==================== 自动滚动抓取 ====================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoScrape() {
    if (running) return;
    running = true;
    setButtonState(true);

    let total = 0;
    let staleRounds = 0;
    const MAX_STALE = 3; // 连续 3 轮无新内容判定到底
    const MAX_ROUNDS = 200; // 安全上限

    // 先扫当前视口
    const initial = scanTweets();
    if (initial.length) {
      total += initial.length;
      await send({ action: "saveTweets", tweets: initial });
    }

    for (let round = 0; round < MAX_ROUNDS && staleRounds < MAX_STALE; round++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1600); // 等待新内容加载

      const fresh = scanTweets();
      if (fresh.length) {
        total += fresh.length;
        staleRounds = 0;
        await send({ action: "saveTweets", tweets: fresh });
        updateButtonText(`已抓取 ${total} 条…`);
      } else {
        staleRounds++;
      }
    }

    running = false;
    setButtonState(false);
    await send({ action: "scrapeComplete", count: total });
    showToast(`抓取完成，共 ${total} 条新书签`);
  }

  // ==================== 浮动按钮 & 提示 ====================

  const BTN_ID = "xb-ai-scrape-btn";
  const TOAST_ID = "xb-ai-toast";

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "AI 抓取书签";
    btn.style.cssText = [
      "position:fixed", "right:24px", "bottom:24px", "z-index:999999",
      "padding:12px 20px", "border:none", "border-radius:999px",
      "background:#1d9bf0", "color:#fff", "font-size:14px", "font-weight:600",
      "cursor:pointer", "box-shadow:0 4px 12px rgba(0,0,0,.3)",
    ].join(";");
    btn.addEventListener("click", autoScrape);
    document.body.appendChild(btn);
  }

  function setButtonState(busy) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = busy;
    btn.style.opacity = busy ? ".7" : "1";
    btn.textContent = busy ? "抓取中…" : "AI 抓取书签";
  }

  function updateButtonText(text) {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.textContent = text;
  }

  function showToast(text) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.style.cssText = [
        "position:fixed", "right:24px", "bottom:84px", "z-index:999999",
        "padding:10px 16px", "border-radius:8px", "background:#0f1419",
        "color:#fff", "font-size:13px", "box-shadow:0 4px 12px rgba(0,0,0,.3)",
        "transition:opacity .3s",
      ].join(";");
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    setTimeout(() => (toast.style.opacity = "0"), 3000);
  }

  // ==================== SPA 路由监听 ====================

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (isBookmarksPage()) injectButton();
    else document.getElementById(BTN_ID)?.remove();
  }, 500);

  function init() {
    if (isBookmarksPage()) injectButton();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
