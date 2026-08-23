/**
 * CONTENT SCRIPT — Runs on X/Twitter Bookmarks page
 * Scrapes tweet cards as the user scrolls and sends them to background.
 *
 * FIXES APPLIED:
 * 1. content_scripts matches now include "https://x.com/i/bookmarks*" (the canonical URL)
 * 2. MutationObserver debounce moved to module-scoped variable (window.* is unreliable in content scripts)
 * 3. chrome.runtime.sendMessage wrapped with try/catch + promise fallback for MV3
 * 4. Multiple fallback selectors for tweet articles (X changes DOM frequently)
 * 5. Better author extraction with multiple selector strategies
 * 6. Proper cleanup on SPA navigation (observer disconnect + clearInterval)
 */

const DEBUG = false;
const debugLog = (...args) => { if (DEBUG) console.log("[XBE]", ...args); };

let scrapedTweetIds = new Set();
let scrapeObserver = null;
let navPollInterval = null;
let scrapeDebounceTimer = null;

function init() {
  if (!isBookmarksPage()) return;
  scrapedTweetIds = new Set();
  startScraping();
  setupNavigationObserver();
}

function isBookmarksPage() {
  const path = window.location.pathname;
  return path.includes("/bookmarks") || path.includes("/i/bookmarks");
}

/**
 * X tweet articles — multiple fallback selectors for resilience.
 * X frequently changes their DOM structure, so we try several patterns.
 */
function findTweetArticles() {
  // Primary: data-testid based (most stable)
  let articles = document.querySelectorAll('article[data-testid="tweet"]');
  if (articles.length > 0) return articles;

  // Fallback 1: role="article"
  articles = document.querySelectorAll('article[role="article"]');
  if (articles.length > 0) return articles;

  // Fallback 2: any article inside main timeline area
  articles = document.querySelectorAll('main article, div[aria-label="Timeline"] article');
  return articles;
}

function parseTweet(article) {
  try {
    // 1. Tweet link — extract from time element's parent anchor
    const timeEl = article.querySelector("a[href*='/status/'] time, time");
    if (!timeEl) return null;

    const timeAnchor = timeEl.closest("a[href*='/status/']");
    if (!timeAnchor) return null;

    const href = timeAnchor.getAttribute("href") || "";
    const tweetIdMatch = href.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;
    if (!tweetId || scrapedTweetIds.has(tweetId)) return null;

    // 2. Author info — multiple strategies
    const displayNameEl =
      article.querySelector('[data-testid="User-Name"] a[role="link"] span') ||
      article.querySelector('[data-testid="User-Name"] a') ||
      article.querySelector('a[role="link"] span');
    const displayName = displayNameEl?.textContent?.trim() || "";

    // Extract handle from the tweet URL itself (most reliable)
    const handleMatch = href.match(/^\/([^/]+)\//);
    const handle = handleMatch ? `@${handleMatch[1]}` : "";

    // 3. Tweet content
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const content = textEl ? getTextWithLinks(textEl) : "";

    // 4. Time
    const datetime = timeEl.getAttribute("datetime") || "";

    // 5. Media (images/videos)
    const mediaUrls = [];
    article.querySelectorAll('img[src*="pbs.twimg.com"]').forEach((img) => {
      const src = img.src || "";
      // Skip tiny avatar images
      if (src.includes("profile_images") || src.includes("emoji")) return;
      if (src && !mediaUrls.includes(src)) mediaUrls.push(src);
    });
    article.querySelectorAll("video").forEach((video) => {
      const src = video.src || video.getAttribute("data-src") || "";
      if (src && !mediaUrls.includes(src)) mediaUrls.push(src);
    });

    // 6. Interaction stats
    const stats = {};
    article.querySelectorAll('[data-testid$="Count"], [aria-label]').forEach((el) => {
      const testid = el.getAttribute("data-testid") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const text = el.textContent || "";
      const num = parseInt(text.replace(/[^0-9]/g, "")) || 0;

      if (testid.includes("reply") || ariaLabel.toLowerCase().includes("repl")) stats.replies = num;
      if (testid.includes("retweet") || ariaLabel.toLowerCase().includes("repost") || ariaLabel.toLowerCase().includes("retweet")) stats.retweets = num;
      if (testid.includes("like") || ariaLabel.toLowerCase().includes("like")) stats.likes = num;
      if (testid.includes("bookmark") || ariaLabel.toLowerCase().includes("bookmark")) stats.bookmarks = num;
    });

    // Also try aria-label based extraction (more reliable in some X versions)
    if (!stats.likes || !stats.retweets) {
      article.querySelectorAll("button[aria-label]").forEach((btn) => {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        const num = parseInt(label.replace(/[^0-9]/g, "")) || 0;
        if (label.includes("like") && !stats.likes) stats.likes = num;
        if ((label.includes("repost") || label.includes("retweet")) && !stats.retweets) stats.retweets = num;
        if (label.includes("repl") && !stats.replies) stats.replies = num;
      });
    }

    return {
      id: tweetId,
      url: `https://x.com${href}`,
      author: { name: displayName, handle },
      content,
      publishedAt: datetime,
      scrapedAt: Date.now(),
      mediaUrls,
      stats,
      tags: [],
      summary: "",
      category: "",
    };
  } catch (e) {
    debugLog("Parse error:", e);
    return null;
  }
}

/**
 * Preserve link text in tweet content (t.co short links display as original text).
 */
function getTextWithLinks(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll("a").forEach((a) => {
    const span = document.createElement("span");
    span.textContent = ` ${a.textContent} `;
    a.replaceWith(span);
  });
  return clone.textContent.trim();
}

function scrapeVisibleTweets() {
  const articles = findTweetArticles();
  if (!articles.length) return;

  const newTweets = [];
  articles.forEach((article) => {
    const tweet = parseTweet(article);
    if (tweet) {
      scrapedTweetIds.add(tweet.id);
      newTweets.push(tweet);
    }
  });

  if (newTweets.length > 0) {
    debugLog("Scraped tweets:", newTweets.length);
    // FIX: wrap sendMessage in try/catch — MV3 may throw if extension context invalidated
    try {
      chrome.runtime
        .sendMessage({ action: "saveTweets", tweets: newTweets })
        .catch((e) => {
          // Context may be invalidated during extension reload
          debugLog("sendMessage failed (context invalidated?):", e?.message);
        });
    } catch (e) {
      debugLog("sendMessage threw:", e?.message);
    }
  }
}

function startScraping() {
  scrapeVisibleTweets();

  if (scrapeObserver) scrapeObserver.disconnect();

  scrapeObserver = new MutationObserver((mutations) => {
    let shouldScrape = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        shouldScrape = true;
        break;
      }
    }
    if (shouldScrape) {
      // FIX: module-scoped debounce instead of window._scrapeDebounce
      clearTimeout(scrapeDebounceTimer);
      scrapeDebounceTimer = setTimeout(scrapeVisibleTweets, 300);
    }
  });

  scrapeObserver.observe(document.body, { childList: true, subtree: true });
}

function stopScraping() {
  if (scrapeObserver) {
    scrapeObserver.disconnect();
    scrapeObserver = null;
  }
  if (scrapeDebounceTimer) {
    clearTimeout(scrapeDebounceTimer);
    scrapeDebounceTimer = null;
  }
}

/**
 * X is a SPA — monitor route changes to start/stop scraping.
 * FIX: use setInterval with proper cleanup (clearInterval on stop).
 */
function setupNavigationObserver() {
  if (navPollInterval) clearInterval(navPollInterval);

  let lastPath = window.location.pathname;
  navPollInterval = setInterval(() => {
    const currentPath = window.location.pathname;
    if (currentPath !== lastPath) {
      lastPath = currentPath;
      if (isBookmarksPage()) {
        scrapedTweetIds.clear();
        startScraping();
      } else {
        stopScraping();
      }
    }
  }, 500);
}

// Initialize
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Listen for messages from sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "manualScrape") {
    scrapeVisibleTweets();
    sendResponse({ count: scrapedTweetIds.size });
    return false;
  }
  if (message.action === "getScrapeStatus") {
    sendResponse({ isBookmarksPage: isBookmarksPage(), scrapedCount: scrapedTweetIds.size });
    return false;
  }
  return false;
});
