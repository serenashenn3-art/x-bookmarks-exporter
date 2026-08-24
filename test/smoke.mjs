/**
 * test/smoke.mjs — lib 纯逻辑模块冒烟测试（Node 直接运行，无 chrome 依赖）
 * 运行: node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { CATEGORIES, NATURES, ACTIONS, DEFAULT_CLASSIFICATION, UNCATEGORIZED } from "../lib/constants.js";
import { buildClassificationPrompt, buildGroupSummaryPrompt, extractJson, normalizeClassification } from "../lib/prompt.js";
import { PROVIDERS, normalizeAiConfig, buildRequest, parseResponse } from "../lib/ai-providers.js";
import { toMarkdown, toCSV, toJSON, buildExport } from "../lib/export.js";

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("  ✓", name);
};

// ---------- 假数据 ----------
const tweets = [
  {
    id: "111",
    url: "https://x.com/alice/status/111",
    author: { name: "Alice", handle: "@alice" },
    content: "一个很棒的 LLM 开源工具\n带换行, 和\"引号\"",
    publishedAt: "2026-08-20T10:00:00Z",
    category: "AI/技术",
    nature: "工具资源",
    tags: ["llm", "开源"],
    summary: "推荐一个 LLM 工具",
    action: "可试用",
    classifiedAt: 1,
  },
  {
    id: "222",
    url: "https://x.com/bob/status/222",
    author: { name: "Bob", handle: "@bob" },
    content: "关于创业的一些思考",
    publishedAt: "2026-08-21T10:00:00Z",
    category: "商业/投资",
    nature: "观点评论",
    tags: ["创业"],
    summary: "创业思考",
    action: "稍后阅读",
    classifiedAt: 2,
  },
];

// ---------- constants ----------
t("constants: 维度枚举符合规格", () => {
  assert.equal(CATEGORIES.length, 8);
  assert.equal(NATURES.length, 8);
  assert.equal(ACTIONS.length, 6);
  assert.equal(UNCATEGORIZED, "未分类");
  assert.equal(DEFAULT_CLASSIFICATION.category, "未分类");
});

// ---------- prompt 构建 ----------
t("buildClassificationPrompt: 含全部维度与推文内容", () => {
  const msgs = buildClassificationPrompt(tweets[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.ok(msgs[0].content.includes("category") && msgs[0].content.includes("action"));
  assert.ok(msgs[1].content.includes("@alice") && msgs[1].content.includes("LLM"));
});

t("buildGroupSummaryPrompt: 包含组名与条数", () => {
  const msgs = buildGroupSummaryPrompt(tweets, "AI/技术");
  assert.ok(msgs[1].content.includes("AI/技术") && msgs[1].content.includes("共 2 条"));
});

// ---------- AI 响应解析容错 ----------
t("extractJson: 直接 JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});
t("extractJson: 去 markdown 代码块标记", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});
t("extractJson: 前后有多余文字", () => {
  assert.deepEqual(extractJson('好的，结果是 {"a":1} 希望有帮助'), { a: 1 });
});
t("extractJson: 尾逗号容错", () => {
  assert.deepEqual(extractJson('{"a":1,}'), { a: 1 });
});
t("extractJson: 空输入抛错", () => {
  assert.throws(() => extractJson(""));
});

t("normalizeClassification: 合法输入保留", () => {
  const r = normalizeClassification(
    { category: "AI/技术", nature: "工具资源", tags: ["a", "b"], summary: "摘要", action: "可引用" },
    tweets[0]
  );
  assert.equal(r.category, "AI/技术");
  assert.equal(r.action, "可引用");
  assert.ok(r.classifiedAt > 0);
});
t("normalizeClassification: 非法枚举值降级为未分类", () => {
  const r = normalizeClassification({ category: "胡说", nature: "乱写", action: "不存在", tags: "x" }, tweets[0]);
  assert.equal(r.category, "未分类");
  assert.equal(r.nature, "未分类");
  assert.equal(r.action, "稍后阅读");
  assert.deepEqual(r.tags, []);
});
t("normalizeClassification: null 输入给默认分类", () => {
  assert.deepEqual(normalizeClassification(null), { ...DEFAULT_CLASSIFICATION });
});
t("normalizeClassification: 超长摘要截断", () => {
  const r = normalizeClassification({ summary: "x".repeat(100) }, tweets[0]);
  assert.ok(r.summary.length <= 60);
});

// ---------- AI 提供商适配 ----------
t("buildRequest(openai): 鉴权头 + chat/completions", () => {
  const cfg = normalizeAiConfig({ provider: "openai", apiKey: "sk-x" });
  const req = buildRequest(cfg, [{ role: "user", content: "hi" }], { jsonMode: true });
  assert.equal(req.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer sk-x");
  assert.equal(req.body.response_format.type, "json_object");
});
t("buildRequest(claude): x-api-key + system 分离", () => {
  const cfg = normalizeAiConfig({ provider: "claude", apiKey: "k" });
  const req = buildRequest(cfg, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "k");
  assert.equal(req.body.system, "sys");
  assert.deepEqual(req.body.messages, [{ role: "user", content: "hi" }]);
});
t("buildRequest(gemini): key 在 query，systemInstruction 分离", () => {
  const cfg = normalizeAiConfig({ provider: "gemini", apiKey: "g" });
  const req = buildRequest(cfg, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.ok(req.url.includes("generateContent?key=g"));
  assert.equal(req.body.systemInstruction.parts[0].text, "sys");
  assert.equal(req.body.contents[0].role, "user");
});
t("buildRequest(ollama): 无鉴权头", () => {
  const cfg = normalizeAiConfig({ provider: "ollama" });
  const req = buildRequest(cfg, [{ role: "user", content: "hi" }]);
  assert.equal(req.headers.Authorization, undefined);
  assert.ok(req.url.startsWith("http://localhost:11434/v1"));
});
t("buildRequest: 自定义 Base URL", () => {
  const cfg = normalizeAiConfig({ provider: "openai", apiKey: "k", baseUrl: "https://proxy.example.com/v1/" });
  assert.equal(buildRequest(cfg, []).url, "https://proxy.example.com/v1/chat/completions");
});
t("normalizeAiConfig: 未知提供商回退默认", () => {
  assert.equal(normalizeAiConfig({ provider: "nope" }).provider, "kimi");
});

t("parseResponse(openai 风格)", () => {
  assert.equal(parseResponse("kimi", { choices: [{ message: { content: "你好" } }] }), "你好");
});
t("parseResponse(claude 风格)", () => {
  assert.equal(parseResponse("claude", { content: [{ type: "text", text: "ok" }] }), "ok");
});
t("parseResponse(gemini 风格)", () => {
  assert.equal(parseResponse("gemini", { candidates: [{ content: { parts: [{ text: "ok" }] } }] }), "ok");
});
t("parseResponse: 空响应抛错（触发降级路径）", () => {
  assert.throws(() => parseResponse("openai", { choices: [] }));
});
t("PROVIDERS: 8 家齐全", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ["claude", "gemini", "glm", "kimi", "minimax", "ollama", "openai", "qwen"]);
});

// ---------- 导出 ----------
t("toMarkdown: 按领域分组为二级标题", () => {
  const md = toMarkdown(tweets);
  assert.ok(md.includes("## AI/技术（1）"));
  assert.ok(md.includes("## 商业/投资（1）"));
  assert.ok(md.includes("推荐一个 LLM 工具") && md.includes("@alice") && md.includes("https://x.com/alice/status/111"));
  assert.ok(md.includes("`#llm`"));
});
t("toCSV: 表头正确、标签分号分隔、正文去换行", () => {
  const csv = toCSV(tweets);
  const lines = csv.split("\n");
  assert.equal(lines[0], "ID,作者,正文,摘要,领域,性质,标签,建议操作,日期,链接");
  assert.ok(lines[1].includes('"llm;开源"'));
  assert.ok(!lines[1].includes("带换行\n"));
  assert.ok(lines[1].includes('"一个很棒的 LLM 开源工具 带换行, 和""引号"""'));
});
t("toJSON: 完整字段数组可解析", () => {
  const parsed = JSON.parse(toJSON(tweets));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "111");
});
t("buildExport: 各格式文件名与 MIME", () => {
  assert.match(buildExport(tweets, "markdown").filename, /\.md$/);
  assert.match(buildExport(tweets, "json").filename, /\.json$/);
  assert.equal(buildExport(tweets, "csv").mimeType, "text/csv");
});

// ---------- 去重 Map 逻辑（与 content/scraper.js 相同模式） ----------
t("去重: Map 判重逻辑", () => {
  const scrapedIds = new Map();
  const incoming = [{ id: "1" }, { id: "2" }, { id: "1" }, { id: "3" }];
  const fresh = incoming.filter((x) => !scrapedIds.has(x.id) && (scrapedIds.set(x.id, true), true));
  assert.deepEqual(fresh.map((x) => x.id), ["1", "2", "3"]);
});

console.log(`\n全部通过：${passed} 项`);
