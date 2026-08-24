/**
 * lib/ai-providers.js — 多 AI 提供商统一调用层
 *
 * 每个适配器标准化三件事：鉴权头、请求体格式、响应解析。
 * - openai 兼容系（openai/kimi/qwen/glm/minimax/ollama）走 chat/completions
 * - claude 走 Anthropic messages API
 * - gemini 走 generateContent（key 放在 query）
 *
 * buildRequest / parseResponse 为纯函数，便于 Node 冒烟测试；
 * callAI 依赖 fetch（SW 与 Node 18+ 均可用），不依赖 chrome API。
 */

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    style: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    needsKey: true,
  },
  claude: {
    label: "Claude (Anthropic)",
    style: "claude",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    models: ["claude-3-5-haiku-latest", "claude-sonnet-4-5", "claude-opus-4-1"],
    needsKey: true,
  },
  gemini: {
    label: "Gemini (Google)",
    style: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
    needsKey: true,
  },
  kimi: {
    label: "Kimi (月之暗面)",
    style: "openai",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0905-preview"],
    needsKey: true,
  },
  qwen: {
    label: "通义千问 (阿里)",
    style: "openai",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
    needsKey: true,
  },
  glm: {
    label: "智谱 GLM",
    style: "openai",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
    needsKey: true,
  },
  minimax: {
    label: "MiniMax",
    style: "openai",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-Text-01",
    models: ["MiniMax-Text-01", "abab6.5s-chat"],
    needsKey: true,
  },
  ollama: {
    label: "Ollama (本地)",
    style: "openai",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    models: ["llama3.1", "qwen2.5", "deepseek-r1"],
    needsKey: false,
  },
};

export const DEFAULT_PROVIDER = "kimi";

/** 规范化配置（读自 chrome.storage.sync） */
export function normalizeAiConfig(input = {}) {
  const provider = PROVIDERS[input.provider] ? input.provider : DEFAULT_PROVIDER;
  const meta = PROVIDERS[provider];
  return {
    provider,
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : "",
    model:
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : meta.defaultModel,
    baseUrl:
      typeof input.baseUrl === "string" && input.baseUrl.trim()
        ? input.baseUrl.trim().replace(/\/+$/, "")
        : meta.defaultBaseUrl,
  };
}

/**
 * 构建请求 { url, headers, body }（纯函数）。
 * @param {object} config normalizeAiConfig 结果
 * @param {Array<{role:string, content:string}>} messages
 * @param {{maxTokens?:number, temperature?:number, jsonMode?:boolean}} [opts]
 */
export function buildRequest(config, messages, opts = {}) {
  const meta = PROVIDERS[config.provider];
  if (!meta) throw new Error(`未知 AI 提供商: ${config.provider}`);
  const maxTokens = opts.maxTokens ?? 1024;
  const temperature = opts.temperature ?? 0.3;

  if (meta.style === "claude") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const chatMessages = messages.filter((m) => m.role !== "system");
    return {
      url: `${config.baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: config.model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
      },
    };
  }

  if (meta.style === "gemini") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const chatMessages = messages.filter((m) => m.role !== "system");
    return {
      url: `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
      headers: { "Content-Type": "application/json" },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: chatMessages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      },
    };
  }

  // openai 兼容系
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const body = { model: config.model, messages, temperature };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers,
    body,
  };
}

/**
 * 解析响应为纯文本（纯函数）。响应非 2xx 时由 callAI 处理，这里拿到的是 body JSON。
 * @returns {string} AI 文本输出
 */
export function parseResponse(provider, data) {
  const meta = PROVIDERS[provider];
  if (meta?.style === "claude") {
    const text = (data?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim()) return text;
  } else if (meta?.style === "gemini") {
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");
    if (text.trim()) return text;
  } else {
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text;
  }
  throw new Error("AI 响应为空或格式无法识别");
}

/**
 * 统一 AI 调用入口。失败时抛出带 message 的 Error，由调用方决定降级策略。
 */
export async function callAI(config, messages, opts = {}) {
  const meta = PROVIDERS[config.provider];
  if (meta.needsKey && !config.apiKey) {
    const err = new Error(`未配置 ${meta.label} 的 API Key，请先到设置页填写`);
    err.code = "NO_AI_KEY";
    throw err;
  }

  const req = buildRequest(config, messages, opts);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`AI API 返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const msg =
      data?.error?.message || data?.error?.type || data?.message || `HTTP ${res.status}`;
    const err = new Error(`AI API 错误: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return parseResponse(config.provider, data);
}

/** 测试连接：发一条极简消息，返回 { ok, message } */
export async function testConnection(config) {
  try {
    const text = await callAI(
      config,
      [{ role: "user", content: "回复 OK 两个字母即可。" }],
      { maxTokens: 16, temperature: 0 }
    );
    return { ok: true, message: `连接成功，模型响应: ${text.slice(0, 50)}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
