/**
 * options.js — Settings page logic
 *
 * FIX APPLIED:
 * 1. options.html now loads settings.js BEFORE options.js
 *    (original code referenced XBE_SETTINGS but never loaded the file)
 * 2. Added proper input validation on save
 */

const STORAGE_KEY = "xbe_settings";

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const settings = XBE_SETTINGS.normalize(stored[STORAGE_KEY] || {});

  document.getElementById("aiApiKey").value = settings.aiApiKey;
  document.getElementById("maxStorage").value = settings.maxStorageTweets;
  document.getElementById("autoCategorize").checked = settings.autoCategorize;

  document.getElementById("saveBtn").addEventListener("click", async () => {
    const apiKey = document.getElementById("aiApiKey").value.trim();
    const maxStorage = parseInt(document.getElementById("maxStorage").value) || 5000;
    const autoCategorize = document.getElementById("autoCategorize").checked;

    if (maxStorage < 100 || maxStorage > 10000) {
      showStatus("Max bookmarks must be between 100 and 10000", "error");
      return;
    }

    const newSettings = {
      aiApiKey: apiKey,
      maxStorageTweets: Math.min(10000, Math.max(100, maxStorage)),
      autoCategorize,
    };

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: newSettings });
      showStatus("Saved", "success");
    } catch (e) {
      showStatus(`Error: ${e.message}`, "error");
    }
  });
});

function showStatus(message, type) {
  const status = document.getElementById("saveStatus");
  status.textContent = message;
  status.className = `save-status ${type}`;
  setTimeout(() => {
    status.textContent = "";
    status.className = "";
  }, 2000);
}
