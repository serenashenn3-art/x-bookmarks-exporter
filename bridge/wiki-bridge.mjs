/**
 * bridge/wiki-bridge.mjs — X 书签 ⇄ 笔记软件的通用 Wiki 桥（本地服务）
 *
 * 职责：
 *  - 对扩展暴露 HTTP API（契约见 lib/wiki-api.js）：
 *      GET  /api/health  → { ok, version, sinks }
 *      GET  /api/sinks   → { ok, sinks: [{id, label, type}] }   供设置页选择推送目标
 *      POST /api/pages   → 接收书签内容（body.target 指定 sink id，缺省走 default sink）
 *      POST /api/llm     → 扩展同步 AI 配置（provider/baseUrl/model/key），key 只需在扩展里输一次
 *  - 把每条内容写成标准 Markdown（YAML frontmatter + 正文 + 标签）到目标 sink 目录，
 *    Obsidian / Logseq / Typora / VS Code 等 md 系笔记直接可用
 *  - sink 配 autoIngest 且 llm 已配置时，自动做实体抽取，把概念页写进 sink.wikiDir
 *    （内置实现，直接调 OpenAI 兼容 /chat/completions，无需安装任何 CLI）
 *  - 自带网页浏览界面：GET / 列表 · GET /pages/:id 详情
 *
 * 配置：bridge/config.json（参考 bridge/config.example.json，真实配置不要提交——含 API key；
 *        每次启动/修改会自动备份到 ~/.xbe-wiki-bridge.config.json，本地配置丢失时自动从备份恢复）
 * 运行：node bridge/wiki-bridge.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(BRIDGE_DIR, "config.json");
// 备份配置：bridge/ 目录可能被覆盖重装（如解压新版 ZIP），家目录下的备份用于自动恢复
const BACKUP_CONFIG_PATH = path.join(os.homedir(), ".xbe-wiki-bridge.config.json");
const DATA_DIR = path.join(BRIDGE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "pages.json");
const INGEST_LOG = path.join(DATA_DIR, "ingest.log");
const VERSION = "0.5.2";

// ==================== 配置 ====================

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // 本地配置正常时顺带刷新备份
    try { fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch {}
    return cfg;
  } catch {
    try {
      const backup = JSON.parse(fs.readFileSync(BACKUP_CONFIG_PATH, "utf8"));
      // 用备份恢复本地配置
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(backup, null, 2), { mode: 0o600 }); } catch {}
      console.log("[bridge] config.json 缺失，已从备份恢复:", BACKUP_CONFIG_PATH);
      return backup;
    } catch {
      return { port: 19828, sinks: [], llm: {} };
    }
  }
}

/** 写配置：本地 + 家目录备份双写 */
function saveConfig() {
  const text = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_PATH, text, { mode: 0o600 });
  try { fs.writeFileSync(BACKUP_CONFIG_PATH, text, { mode: 0o600 }); } catch {}
}
const config = loadConfig();
const PORT = config.port || 19828;
const expandHome = (p) => (p || "").replace(/^~/, os.homedir());
const sinks = (config.sinks || []).map((s) => ({ ...s, path: expandHome(s.path), wikiDir: expandHome(s.wikiDir) }));
for (const s of sinks) fs.mkdirSync(s.path, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// llm 配置归一化：provider 缺省 minimax；baseUrl/model 按 provider 给默认值（OpenAI 兼容接口即可）
const LLM_DEFAULTS = {
  minimax: { baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-Text-01" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
};
const llm = (() => {
  const c = config.llm || {};
  const d = LLM_DEFAULTS[c.provider || "minimax"] || LLM_DEFAULTS.minimax;
  return { provider: c.provider || "minimax", baseUrl: (c.baseUrl || d.baseUrl).replace(/\/+$/, ""), model: c.model || d.model, key: c.key || "" };
})();
const llmReady = () => Boolean(llm.key) || llm.provider === "ollama";

function pickSinks(target) {
  if (!sinks.length) return [];
  if (target) {
    const hit = sinks.find((s) => s.id === target);
    return hit ? [hit] : [];
  }
  const def = sinks.filter((s) => s.default);
  return def.length ? def : [sinks[0]];
}

// ==================== 数据（按 externalId 去重持久化） ====================

const pages = new Map();
try {
  for (const p of JSON.parse(fs.readFileSync(DB_PATH, "utf8"))) pages.set(p.externalId, p);
} catch { /* 首次启动无数据 */ }
const persist = () => fs.writeFileSync(DB_PATH, JSON.stringify([...pages.values()], null, 2));

// ==================== Markdown 落盘 ====================

const safeName = (s) => String(s || "untitled").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

/** 写成标准 Markdown（YAML frontmatter + 正文 + callout + #标签），md 系笔记通用 */
function writeMarkdown(p, sink) {
  const tags = (p.tags || []).map((t) => String(t).replace(/\s+/g, "_"));
  const md = [
    "---",
    `id: ${p.externalId}`,
    `author: "${p.author || ""} ${p.authorHandle || ""}"`.trim(),
    `date: ${(p.publishedAt || "").slice(0, 10)}`,
    `category: ${p.category || ""}`,
    `nature: ${p.nature || ""}`,
    `tags: [${tags.join(", ")}]`,
    `url: ${p.url || ""}`,
    "---",
    "",
    `# ${p.title || "无标题"}`,
    "",
    p.content || "（无正文）",
  ];
  if (p.summary) md.push("", `> [!summary] AI 摘要`, `> ${p.summary}`);
  if (p.note) md.push("", `> [!note] 备注`, ...String(p.note).split("\n").map((l) => `> ${l}`));
  for (const img of p.images || []) md.push("", `![](${img})`);
  if (tags.length) md.push("", tags.map((t) => `#${t}`).join(" "));
  md.push("", `[原文链接](${p.url || ""})`);
  const file = path.join(sink.path, `${safeName(p.title)}-${p.externalId}.md`);
  // 运行期间目录可能被用户删除/移动，写入前确保存在（启动时的 mkdir 不覆盖这种情况）
  fs.mkdirSync(sink.path, { recursive: true });
  fs.writeFileSync(file, md.join("\n"));
  return file;
}

// ==================== index.md / log.md（Karpathy LLM Wiki 范式） ====================
// index.md：内容目录，LLM 回答问题时先读它再深入具体页；每次推送后整体重建
// log.md：时间线日志，统一前缀 `## [日期] ingest | ...`，可用 grep '^## \[' 解析

function appendLog(sink, line) {
  try {
    fs.appendFileSync(path.join(sink.path, "log.md"), line + "\n");
  } catch { /* 目录不可写时静默跳过，不影响主流程 */ }
}

function rebuildIndex(sink) {
  try {
    const wikiDir = sink.wikiDir || path.join(sink.path, "wiki");
    let concepts = [];
    try {
      concepts = fs
        .readdirSync(wikiDir)
        .filter((f) => f.endsWith(".md") && !["index.md", "log.md"].includes(f))
        .map((f) => f.replace(/\.md$/, ""))
        .sort();
    } catch { /* 无 wiki 目录 */ }
    const sources = [...pages.values()].filter((p) => String(p.sinksWritten || "").split(",").includes(sink.id));
    const lines = [
      "# 索引（自动生成，请勿手改）",
      "",
      "> 每次推送由桥接服务重建。LLM 使用时：先读本文件定位相关页，再深入阅读。",
      "",
      `## 概念页（${concepts.length}）`,
      "",
      ...concepts.map((n) => `- [[${n}]]`),
      "",
      `## 源书签（${sources.length}）`,
      "",
      ...sources.map((p) => `- [[${p.title}]] — ${p.author || ""}${p.authorHandle || ""} · ${(p.publishedAt || "").slice(0, 10)} · ${p.category || ""} · ${p.nature || ""}`),
      "",
    ];
    fs.writeFileSync(path.join(sink.path, "index.md"), lines.join("\n"));
  } catch { /* 索引重建失败不影响主流程 */ }
}

/** 推送后维护 index/log：log 追加一行，index 整体重建 */
function trackIngest(sink, p, action) {
  appendLog(sink, `## [${new Date().toISOString().slice(0, 10)}] ${action} | ${p.title} → ${sink.id}`);
  rebuildIndex(sink);
}

// ==================== 内置 LLM ingest（实体抽取 → wiki 概念页） ====================

function ingestLog(line) {
  fs.appendFileSync(INGEST_LOG, `${new Date().toISOString()} ${line}\n`);
}

/** 调 OpenAI 兼容 /chat/completions，返回文本；失败抛错 */
async function callLLM(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(llm.key ? { Authorization: `Bearer ${llm.key}` } : {}) },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("LLM 返回为空");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 LLM 输出里宽容地抠出 JSON 对象 */
function parseJsonLoose(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 对一条已落盘的笔记做实体抽取，把概念页写进 sink.wikiDir（缺省 <sink.path>/wiki），
 * 并在笔记末尾追加「相关概念」双链，Obsidian 图谱直接连成网。
 * 返回更新的概念名数组；未启用/未配置 LLM 时返回 null。
 */
async function ingestPage(p, sink) {
  const wikiDir = sink.wikiDir || path.join(sink.path, "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  const prompt = [
    "你是个人知识库助手。从下面的推文笔记中提取 1-4 个核心概念/实体（技术、产品、人物、方法论等），用于构建 wiki。",
    '只输出 JSON，不要输出其他任何内容：{"entities":[{"name":"概念名（精炼，不超过10字）","desc":"2-3句解释这个概念","relation":"它与本文的关系（1句）"}]}',
    "",
    `标题：${p.title || ""}`,
    `摘要：${p.summary || ""}`,
    `正文：${String(p.content || "").slice(0, 3000)}`,
  ].join("\n");
  const parsed = parseJsonLoose(await callLLM(prompt));
  const entities = (parsed?.entities || []).filter((e) => e && e.name).slice(0, 4);
  if (!entities.length) throw new Error("未抽取到实体");

  const date = (p.publishedAt || "").slice(0, 10);
  const noteLink = `[[${p.title || p.externalId}]]`;
  const updated = [];
  for (const e of entities) {
    const file = path.join(wikiDir, `${safeName(e.name)}.md`);
    const bullet = `- ${noteLink}（${date}）：${e.relation || ""}`.trim();
    if (fs.existsSync(file)) {
      fs.appendFileSync(file, `\n${bullet}`);
    } else {
      fs.writeFileSync(file, [
        "---", "type: wiki", `created: ${date}`, "---", "",
        `# ${e.name}`, "", e.desc || "", "", "## 相关内容", bullet,
      ].join("\n"));
    }
    updated.push(e.name);
  }

  // 回写双链到笔记本身
  const noteFile = path.join(sink.path, `${safeName(p.title)}-${p.externalId}.md`);
  if (fs.existsSync(noteFile)) {
    fs.appendFileSync(noteFile, `\n\n相关概念： ${entities.map((e) => `[[${e.name}]]`).join(" · ")}`);
  }
  return updated;
}

/** 自动 ingest：开关+LLM 就绪才跑；异步执行，失败只记日志，不影响主流程 */
function autoIngest(p, sink) {
  if (!sink.autoIngest) return;
  if (!llmReady()) { ingestLog(`跳过 ingest（LLM 未配置 key）: ${p.externalId}`); return; }
  ingestPage(p, sink)
    .then((names) => ingestLog(`ingest 成功: ${p.externalId} → ${names.join(", ")}`))
    .catch((err) => ingestLog(`ingest 失败: ${p.externalId}: ${err.message}`));
}

// ==================== 网页界面 ====================

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function listPage() {
  const items = [...pages.values()].reverse().map((p) => `
    <div class="card">
      <div class="title"><a href="/pages/${esc(p.externalId)}">${esc(p.title)}</a></div>
      <div class="meta">${esc(p.author)} ${esc(p.authorHandle)} · ${esc(p.category)} · ${esc(p.nature)} · ${(p.publishedAt || "").slice(0, 10)} · sink: ${esc(p.sinksWritten || "-")}</div>
      <div class="tags">${(p.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join(" ")}</div>
      <div class="summary">${esc(p.summary || (p.content || "").slice(0, 100))}</div>
      <button class="ingest-btn" data-id="${esc(p.externalId)}">🧠 生成概念页</button><span class="ingest-msg" id="m-${esc(p.externalId)}"></span>
    </div>`).join("");
  const sinkList = sinks.map((s) => `<li>${esc(s.id)}（${esc(s.label || s.path)}）${s.default ? " · 默认" : ""}${s.autoIngest ? " · 自动 ingest" : ""}</li>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Wiki 桥</title>
  <style>body{font:14px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#0f1419}
  h1{font-size:20px}h2{font-size:15px;margin-top:28px}.card{border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .title a{color:#1d9bf0;text-decoration:none;font-weight:600;font-size:15px}
  .meta{color:#6b7280;font-size:12px;margin-top:2px}.tags{margin-top:4px}.tag{color:#1d9bf0;font-size:12px}
  .summary{margin-top:6px;color:#374151}.empty{color:#9ca3af;text-align:center;padding:40px}.sinks{color:#6b7280;font-size:12px}
  .addsink{border:1px dashed #d1d5db;border-radius:10px;padding:12px 16px;margin-top:8px}
  .addsink input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}
  .addsink label{font-size:12px;color:#6b7280;margin-right:12px}
  button{padding:5px 12px;border:none;border-radius:6px;background:#1d9bf0;color:#fff;font-size:12px;cursor:pointer;margin-top:6px}
  .ingest-btn{background:#eff6ff;color:#1d9bf0}.ingest-msg{font-size:12px;color:#6b7280;margin-left:8px}</style></head>
  <body><h1>📚 Wiki 桥 v${VERSION} · 共 ${pages.size} 条</h1>
  <div class="sinks">LLM：${llmReady() ? `${esc(llm.provider)} / ${esc(llm.model)} ✓` : "未配置 key（自动 ingest 关闭）"}<br>已配置笔记库：<ul>${sinkList || "<li>无</li>"}</ul></div>
  <div class="addsink"><h2>＋ 添加笔记库（任何能读 Markdown 文件夹的软件都行）</h2>
    <input id="s-label" placeholder="名称，如：Logseq 工作库">
    <input id="s-path" placeholder="Markdown 文件夹路径，如 ~/Documents/logseq/pages">
    <input id="s-wiki" placeholder="概念页目录（可选，默认 &lt;上面路径&gt;/wiki）">
    <label><input type="checkbox" id="s-default" style="display:inline;width:auto"> 设为默认</label>
    <label><input type="checkbox" id="s-ingest" style="display:inline;width:auto"> 推送后自动生成概念页</label>
    <button id="s-add">添加</button><span class="ingest-msg" id="s-msg"></span>
  </div>
  ${items || '<div class="empty">暂无内容。在扩展 popup 里点「🧠 存知识库」试试。</div>'}
  <script>
  document.getElementById("s-add").onclick = async () => {
    const msg = document.getElementById("s-msg"); msg.textContent = "…";
    const r = await fetch("/api/sinks", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ label: document.getElementById("s-label").value, path: document.getElementById("s-path").value,
        wikiDir: document.getElementById("s-wiki").value, default: document.getElementById("s-default").checked,
        autoIngest: document.getElementById("s-ingest").checked }) });
    const d = await r.json(); msg.textContent = d.ok ? "✓ 已添加，刷新查看" : "✗ " + d.error;
    if (d.ok) setTimeout(() => location.reload(), 600);
  };
  document.querySelectorAll(".ingest-btn").forEach((b) => b.onclick = async () => {
    const msg = document.getElementById("m-" + b.dataset.id); msg.textContent = "生成中…";
    const r = await fetch("/api/ingest", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ externalId: b.dataset.id }) });
    const d = await r.json();
    msg.textContent = d.ok ? "✓ " + d.results.map((x) => x.entities ? x.entities.join("、") : x.error).join(" / ") : "✗ " + d.error;
  });
  </script>
  </body></html>`;
}

function detailPage(p) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(p.title)}</title>
  <style>body{font:14px/1.8 -apple-system,"PingFang SC",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#0f1419}
  .meta{color:#6b7280;font-size:12px}.content{white-space:pre-wrap;background:#f9fafb;border-left:3px solid #1d9bf0;border-radius:0 6px 6px 0;padding:12px 16px;margin:12px 0}
  .tag{color:#1d9bf0}a{color:#1d9bf0}</style></head>
  <body><p><a href="/">← 返回列表</a></p><h1>${esc(p.title)}</h1>
  <p class="meta">${esc(p.author)} ${esc(p.authorHandle)} · ${esc(p.category)} · ${esc(p.nature)} · ${(p.publishedAt || "").slice(0, 10)}</p>
  <p>${(p.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join(" ")}</p>
  <div class="content">${esc(p.content)}</div>
  ${p.note ? `<p>📝 备注：${esc(p.note)}</p>` : ""}
  <p><a href="${esc(p.url)}" target="_blank">原文 ↗</a></p></body></html>`;
}

// ==================== HTTP 服务 ====================

const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };
  const html = (code, s) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }); res.end(s); };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/health") return json(200, { ok: true, version: VERSION, pages: pages.size, llmReady: llmReady(), llmProvider: llmReady() ? llm.provider : undefined });
  // 扩展把它的 AI 配置同步过来（key 只在扩展设置页输一次，桥接复用同一厂商做实体抽取）
  if (url.pathname === "/api/llm" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const input = JSON.parse(body);
        if (!input.provider) return json(400, { ok: false, error: "provider 必填" });
        if (!input.key && input.provider !== "ollama") return json(400, { ok: false, error: "key 为空" });
        const d = LLM_DEFAULTS[input.provider] || {};
        llm.provider = String(input.provider);
        llm.baseUrl = String(input.baseUrl || d.baseUrl || "").replace(/\/+$/, "");
        llm.model = String(input.model || d.model || "");
        llm.key = String(input.key || "");
        if (!llm.baseUrl) return json(400, { ok: false, error: `未知 provider 且未给 baseUrl: ${input.provider}` });
        config.llm = { provider: llm.provider, baseUrl: llm.baseUrl, model: llm.model, key: llm.key };
        saveConfig();
        console.log(`[bridge] LLM 配置已同步: ${llm.provider} / ${llm.model}`);
        return json(200, { ok: true, provider: llm.provider, model: llm.model });
      } catch (e) { return json(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url.pathname === "/api/sinks" && req.method === "GET") {
    return json(200, { ok: true, sinks: sinks.map((s) => ({ id: s.id, label: s.label || s.path, type: s.type, default: !!s.default })) });
  }
  if (url.pathname === "/api/pages" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        const targets = pickSinks(p.target);
        if (!targets.length) return json(400, { ok: false, error: p.target ? `未知 sink: ${p.target}` : "未配置任何 sink" });
        const existing = pages.get(p.externalId);
        if (existing) {
          // 已存在：补写到尚未写入的 sink（同一条书签可分发到多个目标）
          const already = new Set(String(existing.sinksWritten || "").split(",").filter(Boolean));
          const missing = targets.filter((s) => !already.has(s.id));
          for (const s of missing) {
            writeMarkdown({ ...existing, ...p }, s);
            autoIngest({ ...existing, ...p }, s);
            trackIngest(s, existing, "ingest");
          }
          if (missing.length) {
            existing.sinksWritten = [...already, ...missing.map((s) => s.id)].join(",");
            persist();
          }
          console.log(`[bridge] ${missing.length ? "补写 " + missing.map((s) => s.id).join(",") : "跳过重复"}: ${p.externalId} 「${existing.title}」`);
          return json(200, { ok: true, pageUrl: `http://127.0.0.1:${PORT}/pages/${p.externalId}`, duplicate: true, added: missing.map((s) => s.id) });
        }
        const written = [];
        for (const s of targets) {
          writeMarkdown(p, s);
          written.push(s.id);
          autoIngest(p, s);
          trackIngest(s, p, "ingest");
        }
        pages.set(p.externalId, { ...p, sinksWritten: written.join(",") });
        persist();
        console.log(`[bridge] 新增: ${p.externalId} 「${p.title}」 → ${targets.map((s) => s.id).join(",")} (共 ${pages.size} 页)`);
        return json(200, { ok: true, pageUrl: `http://127.0.0.1:${PORT}/pages/${p.externalId}`, duplicate: false });
      } catch (e) { return json(400, { ok: false, error: e.message }); }
    });
    return;
  }
  // 对已有页面补跑/重跑 ingest（网页界面「生成概念页」按钮用）
  if (url.pathname === "/api/ingest" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { externalId } = JSON.parse(body);
        const p = pages.get(externalId);
        if (!p) return json(404, { ok: false, error: "页面不存在" });
        if (!llmReady()) return json(400, { ok: false, error: "LLM 未配置（config.json 的 llm.key 为空）" });
        const results = [];
        for (const s of sinks) {
          try {
            const names = await ingestPage(p, s);
            results.push({ sink: s.id, entities: names });
            ingestLog(`手动 ingest 成功: ${p.externalId} → ${names.join(", ")}`);
          } catch (e) {
            results.push({ sink: s.id, error: e.message });
            ingestLog(`手动 ingest 失败: ${p.externalId}: ${e.message}`);
          }
        }
        return json(200, { ok: true, results });
      } catch (e) { return json(400, { ok: false, error: e.message }); }
    });
    return;
  }
  // 网页界面添加 sink（免手改 config.json）
  if (url.pathname === "/api/sinks" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const input = JSON.parse(body);
        if (!input.label || !input.path) return json(400, { ok: false, error: "label 和 path 必填" });
        const id = String(input.id || input.label).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").slice(0, 30) || `sink-${Date.now()}`;
        if (sinks.some((s) => s.id === id)) return json(400, { ok: false, error: `sink id 已存在: ${id}` });
        const sink = {
          id, label: String(input.label), type: "markdown",
          path: expandHome(String(input.path)), wikiDir: expandHome(String(input.wikiDir || "")),
          default: !!input.default, autoIngest: !!input.autoIngest,
        };
        if (sink.default) for (const s of sinks) s.default = false;
        fs.mkdirSync(sink.path, { recursive: true });
        sinks.push(sink);
        config.sinks = sinks;
        saveConfig();
        console.log(`[bridge] 新增 sink: ${id} → ${sink.path}`);
        return json(200, { ok: true, sinks: sinks.map((s) => ({ id: s.id, label: s.label, default: !!s.default })) });
      } catch (e) { return json(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url.pathname === "/") return html(200, listPage());
  const m = url.pathname.match(/^\/pages\/(.+)$/);
  if (m && pages.has(m[1])) return html(200, detailPage(pages.get(m[1])));
  if (m) return html(404, "<h1>404</h1><p><a href='/'>返回</a></p>");
  return json(404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[bridge] Wiki 桥 v${VERSION} 已启动: http://127.0.0.1:${PORT} · sinks: ${sinks.map((s) => s.id).join(", ") || "无"} · LLM: ${llmReady() ? `${llm.provider}/${llm.model}` : "未配置"}`)
);
// 启动时为每个 sink 重建索引（历史数据也能立刻有 index.md）
for (const s of sinks) rebuildIndex(s);
