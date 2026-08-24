/**
 * options/options.js — 设置页：AI 提供商选择与配置（chrome.storage.sync 持久化）
 */

import { PROVIDERS, normalizeAiConfig } from "../lib/ai-providers.js";
import { AI_CONFIG_KEY } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

function fillProviders() {
  const sel = $("provider");
  for (const [key, meta] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = meta.label;
    sel.appendChild(opt);
  }
}

function fillModels(providerKey, current) {
  const sel = $("model");
  sel.innerHTML = "";
  for (const m of PROVIDERS[providerKey].models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  if (current && !PROVIDERS[providerKey].models.includes(current)) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = current;
    sel.appendChild(opt);
  }
  sel.value = current || PROVIDERS[providerKey].defaultModel;
}

function updateVisibility(providerKey) {
  const meta = PROVIDERS[providerKey];
  $("apiKeyField").classList.toggle("hidden", !meta.needsKey);
  $("baseUrl").placeholder = meta.defaultBaseUrl;
  $("apiKeyHint").textContent = meta.needsKey ? "" : "本地 Ollama 无需 API Key。";
}

function readForm() {
  return normalizeAiConfig({
    provider: $("provider").value,
    apiKey: $("apiKey").value,
    model: $("model").value,
    baseUrl: $("baseUrl").value,
  });
}

function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
}

/** 自定义 Base URL 时按需申请 optional host 权限 */
async function ensureHostPermission(config) {
  const meta = PROVIDERS[config.provider];
  if (config.baseUrl === meta.defaultBaseUrl) return true;
  try {
    const origin = new URL(config.baseUrl).origin + "/*";
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function init() {
  fillProviders();
  const r = await chrome.storage.sync.get(AI_CONFIG_KEY);
  const config = normalizeAiConfig(r[AI_CONFIG_KEY]);

  $("provider").value = config.provider;
  fillModels(config.provider, config.model);
  updateVisibility(config.provider);
  $("apiKey").value = config.apiKey;
  if (config.baseUrl !== PROVIDERS[config.provider].defaultBaseUrl) {
    $("baseUrl").value = config.baseUrl;
  }

  $("provider").addEventListener("change", () => {
    const p = $("provider").value;
    fillModels(p);
    updateVisibility(p);
    $("baseUrl").value = "";
  });

  $("saveBtn").addEventListener("click", async () => {
    const cfg = readForm();
    if (PROVIDERS[cfg.provider].needsKey && !cfg.apiKey) {
      setStatus("请填写 API Key", false);
      return;
    }
    if (!(await ensureHostPermission(cfg))) {
      setStatus("自定义 Base URL 的域名权限被拒绝", false);
      return;
    }
    await chrome.storage.sync.set({ [AI_CONFIG_KEY]: cfg });
    setStatus("已保存", true);
  });

  $("testBtn").addEventListener("click", async () => {
    const cfg = readForm();
    setStatus("测试中…", true);
    if (!(await ensureHostPermission(cfg))) {
      setStatus("自定义 Base URL 的域名权限被拒绝", false);
      return;
    }
    const r = await chrome.runtime.sendMessage({ action: "testConnection", config: cfg });
    setStatus(r?.message || "无响应", !!r?.ok);
  });
}

init();
