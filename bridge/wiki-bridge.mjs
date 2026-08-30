/**
 * bridge/wiki-bridge.mjs — X 书签 ⇄ 笔记软件的通用 Wiki 桥（本地服务）
 *
 * 职责：
 *  - 对扩展暴露 HTTP API（契约见 lib/wiki-api.js）：
 *      GET  /api/health  → { ok, version, sinks }
 *      GET  /api/sinks   → { ok, sinks: [{id, label, type}] }   供设置页选择推送目标
 *      POST /api/pages   → 接收书签内容（body.target 指定 sink id，缺省走 default sink）
 *  - 把每条内容写成标准 Markdown（YAML frontmatter + 正文 + 标签）到目标 sink 目录，
 *    Obsidian / Logseq / Typora / VS Code 等 md 系笔记直接可用
 *  - sink 配 autoIngest 且 LLM 已配置时，自动调 karpathywiki-cli 生成 wiki 知识页面
 *  - 自带网页浏览界面：GET / 列表 · GET /pages/:id 详情
 *
 * 配置：bridge/config.json（参考 bridge/config.example.json，真实配置不要提交——含 API key）
 * 运行：node bridge/wiki-bridge.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(BRIDGE_DIR, "config.json");
const DATA_DIR = path.join(BRIDGE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "pages.json");
const INGEST_LOG = path.join(DATA_DIR, "ingest.log");
const VERSION = "0.2.0";

// ==================== 配置 ====================

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { port: 19828, sinks: [], llm: {} };
  }
}
const config = loadConfig();
const PORT = config.port || 19828;
const expandHome = (p) => (p || "").replace(/^~/, os.homedir());
const sinks = (config.sinks || []).map((s) => ({ ...s, path: expandHome(s.path), wikiDir: expandHome(s.wikiDir) }));
for (const s of sinks) fs.mkdirSync(s.path, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

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
  fs.writeFileSync(file, md.join("\n"));
  return file;
}

// ==================== karpathywiki-cli 自动 ingest ====================

/** 调 CLI 把刚落盘的 md 转成 wiki 知识页面；CLI 未安装/未配置时跳过，不影响主流程 */
function autoIngest(mdFile, sink) {
  if (!sink.autoIngest || !sink.wikiDir) return;
  const { provider, model, key } = config.llm || {};
  if (!provider || (!key && !["ollama", "lmstudio"].includes(provider))) return;
  const args = ["-y", "karpathywiki-cli", "ingest", "--sources", mdFile, "--wiki", sink.wikiDir, "--provider", provider];
  if (model) args.push("--model", model);
  if (key) args.push("--key", key);
  const child = spawn("npx", args, { env: { ...process.env, LLM_WIKI_API_KEY: key || "" } });
  const log = fs.createWriteStream(INGEST_LOG, { flags: "a" });
  log.write(`\n=== ${new Date().toISOString()} ingest ${mdFile} → ${sink.wikiDir} ===\n`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on("close", (code) => log.write(`=== exit ${code} ===\n`));
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
    </div>`).join("");
  const sinkList = sinks.map((s) => `<li>${esc(s.id)}（${esc(s.label || s.path)}）${s.default ? " · 默认" : ""}${s.autoIngest ? " · 自动 ingest" : ""}</li>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Wiki 桥</title>
  <style>body{font:14px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#0f1419}
  h1{font-size:20px}.card{border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .title a{color:#1d9bf0;text-decoration:none;font-weight:600;font-size:15px}
  .meta{color:#6b7280;font-size:12px;margin-top:2px}.tags{margin-top:4px}.tag{color:#1d9bf0;font-size:12px}
  .summary{margin-top:6px;color:#374151}.empty{color:#9ca3af;text-align:center;padding:40px}.sinks{color:#6b7280;font-size:12px}</style></head>
  <body><h1>📚 Wiki 桥 · 共 ${pages.size} 条</h1>
  <div class="sinks">已配置 sink：<ul>${sinkList || "<li>无（请编辑 bridge/config.json）</li>"}</ul></div>
  ${items || '<div class="empty">暂无内容。在扩展 popup 里点「🧠 存知识库」试试。</div>'}
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
  if (url.pathname === "/api/health") return json(200, { ok: true, version: VERSION, pages: pages.size });
  if (url.pathname === "/api/sinks") {
    return json(200, { ok: true, sinks: sinks.map((s) => ({ id: s.id, label: s.label || s.path, type: s.type, default: !!s.default })) });
  }
  if (url.pathname === "/api/pages" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        const dup = pages.has(p.externalId);
        const targets = pickSinks(p.target);
        if (!targets.length) return json(400, { ok: false, error: p.target ? `未知 sink: ${p.target}` : "未配置任何 sink" });
        if (!dup) {
          const written = [];
          for (const s of targets) {
            const file = writeMarkdown(p, s);
            written.push(s.id);
            autoIngest(file, s);
          }
          pages.set(p.externalId, { ...p, sinksWritten: written.join(",") });
          persist();
        }
        console.log(`[bridge] ${dup ? "跳过重复" : "新增"}: ${p.externalId} 「${p.title}」 → ${targets.map((s) => s.id).join(",")} (共 ${pages.size} 页)`);
        return json(200, { ok: true, pageUrl: `http://127.0.0.1:${PORT}/pages/${p.externalId}`, duplicate: dup });
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
  console.log(`[bridge] Wiki 桥 v${VERSION} 已启动: http://127.0.0.1:${PORT} · sinks: ${sinks.map((s) => s.id).join(", ") || "无"}`)
);
