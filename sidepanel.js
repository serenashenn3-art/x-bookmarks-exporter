/**
 * sidepanel.js — Side panel UI logic
 *
 * FIXES APPLIED:
 * 1. Removed emoji from button text (GitHub/Chrome Web Store review best practice)
 * 2. chrome.runtime.sendMessage wrapped with proper async error handling
 * 3. Export modal event listeners properly cleaned up (modal.remove on close)
 * 4. Toast positioning uses inline styles as fallback (no external CSS dependency)
 * 5. debounce properly scoped (was using global setTimeout without clear)
 */

const DEBUG = false;
const debugLog = (...args) => { if (DEBUG) console.log("[XBE panel]", ...args); };

let currentFilter = {
  search: "",
  tags: [],
  category: "",
  sortBy: "scrapedAt",
  order: "desc",
};
let selectedTweetIds = new Set();

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadTweets();

  const config = await chrome.runtime.sendMessage({ action: "checkConfig" });
  if (!config?.hasAiKey) {
    showToast("Add your AI API key in Settings to enable auto-categorization", "warning");
  }
});

function setupEventListeners() {
  document.getElementById("settingsBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  document.getElementById("searchInput").addEventListener(
    "input",
    debounce((e) => {
      currentFilter.search = e.target.value;
      loadTweets();
    }, 300)
  );

  document.getElementById("categoryFilter").addEventListener("change", (e) => {
    currentFilter.category = e.target.value;
    loadTweets();
  });

  document.getElementById("tagFilter").addEventListener("change", (e) => {
    currentFilter.tags = e.target.value ? [e.target.value] : [];
    loadTweets();
  });

  document.getElementById("aiCategorizeBtn").addEventListener("click", async () => {
    const checkboxes = document.querySelectorAll(".tweet-checkbox:checked");
    const ids = Array.from(checkboxes).map((cb) => cb.dataset.id);
    if (!ids.length) {
      showToast("Select tweets to categorize first", "warning");
      return;
    }
    setLoading(true, "Categorizing with AI...");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "categorizeTweets",
        tweetIds: ids,
      });
      setLoading(false);
      if (result?.success) {
        showToast(`Categorized ${result.categorized} tweets`);
        await loadTweets();
      } else {
        showToast(`Error: ${result?.error || "unknown"}`, "error");
      }
    } catch (e) {
      setLoading(false);
      showToast(`Error: ${e?.message}`, "error");
    }
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    showExportModal();
  });

  document.getElementById("manualScrapeBtn")?.addEventListener("click", async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.url?.includes("x.com") || tabs[0]?.url?.includes("twitter.com")) {
        await chrome.tabs.sendMessage(tabs[0].id, { action: "manualScrape" });
        showToast("Scraping started...");
        setTimeout(loadTweets, 1000);
      } else {
        showToast("Please open your X Bookmarks page first", "warning");
      }
    } catch (e) {
      showToast("Could not reach content script. Refresh the X page?", "error");
    }
  });
}

async function loadTweets() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getTweets",
      filter: currentFilter,
    });

    const list = document.getElementById("tweetList");
    const statsBar = document.getElementById("statsBar");
    const totalCount = document.getElementById("totalCount");

    if (!result?.success) {
      list.innerHTML = `<div class="empty-state error">Error: ${escapeHtml(result?.error || "unknown")}</div>`;
      return;
    }

    updateFilterOptions(result.meta);

    totalCount.textContent = `${result.meta.total} bookmark${result.meta.total !== 1 ? "s" : ""}`;
    statsBar.style.display = "flex";

    if (!result.tweets.length) {
      list.innerHTML = `
        <div class="empty-state">
          <p>No bookmarks found.</p>
          <p>Go to <strong>x.com/i/bookmarks</strong> and scroll to load your saved tweets.</p>
        </div>`;
      return;
    }

    list.innerHTML = "";
    result.tweets.forEach((tweet) => {
      const el = createTweetElement(tweet);
      list.appendChild(el);
    });
  } catch (e) {
    debugLog("loadTweets error:", e);
  }
}

function createTweetElement(tweet) {
  const div = document.createElement("div");
  div.className = "tweet-card";
  div.dataset.id = tweet.id;

  const tagsHtml = (tweet.tags || [])
    .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
    .join("");
  const categoryHtml = tweet.category
    ? `<span class="category-badge">${escapeHtml(tweet.category)}</span>`
    : "";
  const summaryHtml = tweet.summary
    ? `<div class="tweet-summary">${escapeHtml(tweet.summary)}</div>`
    : "";
  const mediaHtml = tweet.mediaUrls?.length
    ? `<div class="tweet-media-hint">${tweet.mediaUrls.length} image${tweet.mediaUrls.length > 1 ? "s" : ""}</div>`
    : "";

  div.innerHTML = `
    <div class="tweet-header">
      <input type="checkbox" class="tweet-checkbox" data-id="${tweet.id}" />
      <div class="tweet-author">
        <strong>${escapeHtml(tweet.author?.name || "Unknown")}</strong>
        <span class="handle">${escapeHtml(tweet.author?.handle || "")}</span>
      </div>
      <div class="tweet-meta">
        ${categoryHtml}
        <span class="date">${formatDate(tweet.publishedAt)}</span>
      </div>
    </div>
    <div class="tweet-content">${escapeHtml(tweet.content)}</div>
    ${summaryHtml}
    ${mediaHtml}
    <div class="tweet-footer">
      <div class="tweet-tags">${tagsHtml}</div>
      <div class="tweet-actions">
        <a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener" class="btn-link">Open</a>
        <button class="btn-link delete-btn" data-id="${tweet.id}">Delete</button>
      </div>
    </div>
  `;

  div.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this bookmark from storage?")) return;
    await chrome.runtime.sendMessage({ action: "deleteTweet", tweetId: tweet.id });
    await loadTweets();
  });

  return div;
}

function updateFilterOptions(meta) {
  const catSelect = document.getElementById("categoryFilter");
  const currentCat = catSelect.value;
  catSelect.innerHTML = '<option value="">All Categories</option>';
  meta.categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  });
  catSelect.value = currentCat;

  const tagSelect = document.getElementById("tagFilter");
  const currentTag = tagSelect.value;
  tagSelect.innerHTML = '<option value="">All Tags</option>';
  meta.tags.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = `#${t}`;
    tagSelect.appendChild(opt);
  });
  tagSelect.value = currentTag;
}

function showExportModal() {
  // Remove any existing modal
  document.querySelector(".modal-overlay")?.remove();

  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal">
      <h3>Export Bookmarks</h3>
      <div class="form-group">
        <label>Format</label>
        <select id="exportFormat">
          <option value="markdown">Markdown (.md)</option>
          <option value="json">JSON (.json)</option>
          <option value="csv">CSV (.csv)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Filter</label>
        <p class="hint">Current filters will be applied: ${currentFilter.search ? `"${escapeHtml(currentFilter.search)}"` : "none"}</p>
      </div>
      <div class="modal-actions">
        <button id="doExport" class="btn-primary">Download</button>
        <button id="cancelExport" class="btn-secondary">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector("#cancelExport").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  modal.querySelector("#doExport").addEventListener("click", async () => {
    const format = modal.querySelector("#exportFormat").value;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "exportTweets",
        format,
        filter: currentFilter,
      });
      closeModal();
      if (result?.success) {
        downloadFile(result.content, result.filename, result.mimeType);
        showToast(`Downloaded ${result.filename}`);
      } else {
        showToast(`Error: ${result?.error || "unknown"}`, "error");
      }
    } catch (e) {
      closeModal();
      showToast(`Error: ${e?.message}`, "error");
    }
  });
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setLoading(show, text = "") {
  document.getElementById("loadingOverlay").style.display = show ? "flex" : "none";
  if (text) document.getElementById("loadingText").textContent = text;
}

function showToast(message, type = "info") {
  // Remove existing toasts
  document.querySelectorAll(".toast").forEach((t) => t.remove());

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  const bg =
    type === "error" ? "#c0392b" : type === "warning" ? "#f39c12" : "#27ae60";
  toast.style.cssText = `
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: ${bg}; color: white; padding: 10px 20px; border-radius: 8px;
    font-size: 13px; z-index: 10000; max-width: 90vw; word-break: break-word;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
