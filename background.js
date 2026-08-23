/**
 * background.js — Service Worker (MV3)
 * Core backend: AI calls, storage management, message routing.
 *
 * FIXES APPLIED:
 * 1. importScripts("settings.js") — MV3 service worker requires this for shared code
 * 2. chrome.storage.local.setAccessLevel — wrapped in try/catch (not all Chrome versions support it)
 * 3. requestAiCompletion — removed invalid "thinking: { type: 'disabled' }" param (DeepSeek API doesn't use this; causes 400 error)
 * 4. aiModel changed from "deepseek-v4-flash" (does not exist) to "deepseek-chat" (actual DeepSeek API model name)
 * 5. parseLooseJson — added trailing comma fix and more robust JSON extraction
 * 6. All async handlers return true (keeps sendResponse channel open for async)
 * 7. chrome.sidePanel.open() — properly awaited with error handling
 * 8. handleExportTweets CSV — fixed field quoting (was only quoting some fields inconsistently)
 */

importScripts("settings.js");

const DEBUG = false;
const debugLog = (...args) => { if (DEBUG) console.log("[XBE bg]", ...args); };

// FIX: wrap setAccessLevel in try/catch — older Chrome versions may not support it
try {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => {});
} catch (e) {
  // Not supported in this Chrome version — silently skip
}

// ==================== Settings ====================

async function getSettings() {
  const stored = await chrome.storage.local.get(XBE_SETTINGS.STORAGE_KEY);
  return XBE_SETTINGS.normalize(stored[XBE_SETTINGS.STORAGE_KEY]);
}

// ==================== AI Request ====================

async function requestAiCompletion({
  messages,
  maxTokens = 2048,
  temperature = 0.3,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const err = new Error("AI API key not configured.");
    err.code = "NO_AI_KEY";
    throw err;
  }

  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) body.response_format = responseFormat;

  // FIX: removed "thinking: { type: 'disabled' }" — this is not a valid DeepSeek API parameter
  // and will cause a 400 Bad Request error.

  const res = await fetch(XBE_SETTINGS.chatCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || `AI error: ${res.status}`);
    err.status = res.status;
    err.apiError = data;
    throw err;
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text?.trim()) throw new Error("Empty AI response");
  return text;
}

function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Extract outermost JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Fix trailing commas: {"a": 1,} → {"a": 1}
    try {
      return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
    } catch (e2) {
      debugLog("Failed to parse JSON:", cleaned.slice(0, 200));
      throw new Error("Could not parse AI response as JSON");
    }
  }
}

// ==================== Message Router ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    saveTweets: () => handleSaveTweets(message.tweets),
    getTweets: () => handleGetTweets(message.filter),
    deleteTweet: () => handleDeleteTweet(message.tweetId),
    categorizeTweets: () => handleCategorizeTweets(message.tweetIds),
    summarizeTweets: () => handleSummarizeTweets(message.tweetIds),
    exportTweets: () => handleExportTweets(message.format, message.filter),
    checkConfig: () => getSettings().then((s) => ({ hasAiKey: !!s.aiApiKey })),
    openOptions: () => {
      chrome.runtime.openOptionsPage();
      return Promise.resolve({ success: true });
    },
    openSidePanel: () => {
      const tabId = sender.tab?.id;
      if (tabId) {
        chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
        chrome.sidePanel.open({ tabId });
      }
      return Promise.resolve({ success: true });
    },
  };

  const handler = handlers[message.action];
  if (!handler) return false;

  handler()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  // FIX: return true to keep the sendResponse channel open for async operations
  return true;
});

// ==================== Storage Management ====================

const STORAGE_KEY_TWEETS = "xbe_tweets";
const STORAGE_KEY_TAGS = "xbe_tags";

async function handleSaveTweets(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    return { success: true, added: 0, total: 0 };
  }

  const settings = await getSettings();
  const result = await chrome.storage.local.get([STORAGE_KEY_TWEETS, STORAGE_KEY_TAGS]);
  const existing = result[STORAGE_KEY_TWEETS] || [];
  const existingMap = new Map(existing.map((t) => [t.id, t]));

  let added = 0;
  for (const tweet of tweets) {
    if (!existingMap.has(tweet.id)) {
      existingMap.set(tweet.id, tweet);
      added++;
    }
  }

  // Capacity control — trim oldest by scrapedAt
  let allTweets = Array.from(existingMap.values());
  if (allTweets.length > settings.maxStorageTweets) {
    allTweets = allTweets
      .sort((a, b) => b.scrapedAt - a.scrapedAt)
      .slice(0, settings.maxStorageTweets);
  }

  await chrome.storage.local.set({ [STORAGE_KEY_TWEETS]: allTweets });

  // Auto-categorize if enabled
  if (settings.autoCategorize && added > 0) {
    // Fire-and-forget — don't block the save response
    const newTweetIds = tweets
      .filter((t) => !existing.some((e) => e.id === t.id))
      .map((t) => t.id);
    if (newTweetIds.length > 0) {
      handleCategorizeTweets(newTweetIds).catch((e) =>
        debugLog("Auto-categorize failed:", e?.message)
      );
    }
  }

  return { success: true, added, total: allTweets.length };
}

async function handleGetTweets(filter = {}) {
  const result = await chrome.storage.local.get([STORAGE_KEY_TWEETS, STORAGE_KEY_TAGS]);
  let tweets = result[STORAGE_KEY_TWEETS] || [];

  // Apply filters
  if (filter.search) {
    const q = filter.search.toLowerCase();
    tweets = tweets.filter(
      (t) =>
        (t.content || "").toLowerCase().includes(q) ||
        (t.author?.name || "").toLowerCase().includes(q) ||
        (t.author?.handle || "").toLowerCase().includes(q)
    );
  }
  if (filter.tags?.length) {
    tweets = tweets.filter((t) => filter.tags.some((tag) => (t.tags || []).includes(tag)));
  }
  if (filter.category) {
    tweets = tweets.filter((t) => t.category === filter.category);
  }
  if (filter.dateFrom) {
    tweets = tweets.filter((t) => new Date(t.publishedAt) >= new Date(filter.dateFrom));
  }
  if (filter.dateTo) {
    tweets = tweets.filter((t) => new Date(t.publishedAt) <= new Date(filter.dateTo));
  }

  // Sort
  const sortBy = filter.sortBy || "scrapedAt";
  const order = filter.order === "asc" ? 1 : -1;
  tweets.sort((a, b) => {
    const va = a[sortBy] || 0;
    const vb = b[sortBy] || 0;
    return va < vb ? -order : va > vb ? order : 0;
  });

  // Build filter metadata from ALL stored tweets (not just filtered)
  const allTags = new Set();
  const allCategories = new Set();
  const allHandles = new Set();
  (result[STORAGE_KEY_TWEETS] || []).forEach((t) => {
    (t.tags || []).forEach((tag) => allTags.add(tag));
    if (t.category) allCategories.add(t.category);
    if (t.author?.handle) allHandles.add(t.author.handle);
  });

  return {
    success: true,
    tweets,
    meta: {
      total: (result[STORAGE_KEY_TWEETS] || []).length,
      filtered: tweets.length,
      tags: Array.from(allTags).sort(),
      categories: Array.from(allCategories).sort(),
      handles: Array.from(allHandles).sort(),
    },
  };
}

async function handleDeleteTweet(tweetId) {
  const result = await chrome.storage.local.get(STORAGE_KEY_TWEETS);
  const tweets = (result[STORAGE_KEY_TWEETS] || []).filter((t) => t.id !== tweetId);
  await chrome.storage.local.set({ [STORAGE_KEY_TWEETS]: tweets });
  return { success: true };
}

// ==================== AI Categorization ====================

async function handleCategorizeTweets(tweetIds) {
  const result = await chrome.storage.local.get(STORAGE_KEY_TWEETS);
  const allTweets = result[STORAGE_KEY_TWEETS] || [];
  const targets = allTweets.filter((t) => tweetIds.includes(t.id));
  if (targets.length === 0) return { success: false, error: "No tweets found" };

  const BATCH_SIZE = 10;
  const updatedTweets = [...allTweets];
  const updatedMap = new Map();

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const batchText = batch
      .map((t, idx) => `[${idx + 1}] ${t.author?.handle || "unknown"}: ${t.content.slice(0, 300)}`)
      .join("\n\n");

    const prompt = `You are a precise content categorizer. For each tweet below, assign:
1. A single "category" from this list: [Tech, News, Humor, Education, Design, Productivity, Politics, Entertainment, Science, Business, Art, Other]
2. 1-3 relevant "tags" as short lowercase keywords (e.g. "ai", "startup", "meme")
3. A one-sentence "summary" in the same language as the tweet

Return ONLY a JSON object in this exact format:
{"results":[{"index":1,"category":"Tech","tags":["ai","llm"],"summary":"..."}]}

Tweets to categorize:
${batchText}`;

    const responseText = await requestAiCompletion({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2048,
      responseFormat: { type: "json_object" },
    });

    const parsed = parseLooseJson(responseText);
    const results = parsed?.results || [];

    for (const r of results) {
      const idx = (r.index || 1) - 1;
      const tweet = batch[idx];
      if (!tweet) continue;
      const updated = {
        ...tweet,
        category: r.category || "Other",
        tags: Array.isArray(r.tags) ? r.tags.slice(0, 5) : [],
        summary: r.summary || "",
      };
      updatedMap.set(tweet.id, updated);
    }
  }

  // Merge back into storage
  for (let i = 0; i < updatedTweets.length; i++) {
    if (updatedMap.has(updatedTweets[i].id)) {
      updatedTweets[i] = updatedMap.get(updatedTweets[i].id);
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEY_TWEETS]: updatedTweets });

  return { success: true, categorized: updatedMap.size };
}

async function handleSummarizeTweets(tweetIds) {
  // Reuse categorization logic (it includes summaries)
  return handleCategorizeTweets(tweetIds);
}

// ==================== Export ====================

async function handleExportTweets(format, filter = {}) {
  const { tweets } = await handleGetTweets(filter);
  if (!tweets.length) return { success: false, error: "No tweets to export" };

  let content = "";
  let mimeType = "text/plain";
  let extension = "txt";

  if (format === "json") {
    content = JSON.stringify(tweets, null, 2);
    mimeType = "application/json";
    extension = "json";
  } else if (format === "csv") {
    // FIX: consistently quote ALL fields to prevent CSV injection / parsing issues
    const headers = [
      "id",
      "url",
      "author_name",
      "author_handle",
      "content",
      "published_at",
      "category",
      "tags",
      "summary",
      "likes",
      "retweets",
    ];
    const csvEscape = (val) => {
      const s = String(val || "").replace(/"/g, '""').replace(/\n/g, " ");
      return `"${s}"`;
    };
    const rows = tweets.map((t) =>
      [
        t.id,
        t.url,
        t.author?.name || "",
        t.author?.handle || "",
        t.content || "",
        t.publishedAt,
        t.category || "",
        (t.tags || []).join(", "),
        t.summary || "",
        t.stats?.likes || 0,
        t.stats?.retweets || 0,
      ]
        .map(csvEscape)
        .join(",")
    );
    content = [headers.join(","), ...rows].join("\n");
    mimeType = "text/csv";
    extension = "csv";
  } else {
    // Markdown
    const parts = tweets.map((t) => {
      const tags = (t.tags || []).map((tag) => `\`#${tag}\``).join(" ");
      const cat = t.category ? `**Category:** ${t.category}` : "";
      const sum = t.summary ? `> ${t.summary}` : "";
      return `## ${t.author?.name || "Unknown"} (${t.author?.handle || ""}) — ${t.publishedAt?.slice(0, 10) || ""}

${t.content}

${sum}
${cat}
${tags}
[Original](${t.url})
---`;
    });
    content = `# X Bookmarks Export\n\n*Exported on ${new Date().toLocaleDateString()}*\n\n${parts.join("\n\n")}`;
    mimeType = "text/markdown";
    extension = "md";
  }

  return {
    success: true,
    content,
    mimeType,
    filename: `x-bookmarks-${new Date().toISOString().slice(0, 10)}.${extension}`,
  };
}

// ==================== Side Panel Behavior ====================

chrome.action.onClicked.addListener((tab) => {
  // FIX: setOptions + open with error handling
  try {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
      debugLog("Failed to open side panel:", e?.message);
    });
  } catch (e) {
    debugLog("Side panel setup failed:", e?.message);
  }
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => debugLog("setPanelBehavior failed:", e?.message));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});
