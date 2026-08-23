/**
 * settings.js — Shared configuration module
 * Loaded by background.js (via importScripts) and options.html (via <script>).
 *
 * IMPORTANT: This file must work in BOTH contexts:
 *   - Service Worker (background.js) via importScripts()
 *   - Regular page context (options.html) via <script> tag
 *
 * It does NOT use ES modules because options.html uses inline scripts
 * and background.js uses importScripts (MV3 service worker limitation).
 */

var XBE_SETTINGS = (() => {
  const STORAGE_KEY = "xbe_settings";

  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-chat",
    autoCategorize: true,
    exportFormat: "markdown",
    maxStorageTweets: 5000,
  });

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: typeof input.aiApiKey === "string" ? input.aiApiKey.trim() : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      autoCategorize: input.autoCategorize !== false,
      exportFormat: ["markdown", "json", "csv"].includes(input.exportFormat)
        ? input.exportFormat
        : "markdown",
      maxStorageTweets:
        typeof input.maxStorageTweets === "number"
          ? Math.min(10000, Math.max(100, input.maxStorageTweets))
          : 5000,
    };
  }

  function chatCompletionsUrl(customBaseUrl) {
    const base = customBaseUrl || DEFAULTS.aiBaseUrl;
    return `${base}/chat/completions`;
  }

  return { STORAGE_KEY, DEFAULTS, normalize, chatCompletionsUrl };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = XBE_SETTINGS;
}
