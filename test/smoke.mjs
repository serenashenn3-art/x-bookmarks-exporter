/**
 * test/smoke.mjs — lib 纯逻辑模块冒烟测试（Node 直接运行，无 chrome 依赖）
 * 运行: node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { CATEGORIES, NATURES, ACTIONS, CONTENT_TYPES, DEFAULT_CLASSIFICATION, DEFAULT_TWEET_FIELDS, UNCATEGORIZED } from "../lib/constants.js";
import { buildClassificationPrompt, buildGroupSummaryPrompt, extractJson, normalizeClassification } from "../lib/prompt.js";
import { PROVIDERS, normalizeAiConfig, buildRequest, parseResponse } from "../lib/ai-providers.js";
import { toMarkdown, toObsidian, toCSV, toJSON, buildExport } from "../lib/export.js";
import { stripOembedHtml, upgradeImageUrl, detectContentType, matchesRead } from "../lib/media.js";
import {
  normalizeWikiConfig,
  isDeepContent,
  routeProcessingMode,
  buildWikiPagePayload,
  WIKI_MAX_CONTENT_LENGTH,
} from "../lib/wiki-api.js";
import { DEFAULT_WIKI_CONFIG } from "../lib/constants.js";

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

t("constants: 内容类型四选一，默认字段齐全", () => {
  assert.deepEqual(CONTENT_TYPES, ["文章", "视频", "图片", "文字"]);
  assert.equal(DEFAULT_TWEET_FIELDS.contentType, "文字");
  assert.equal(DEFAULT_TWEET_FIELDS.read, false);
  assert.equal(DEFAULT_TWEET_FIELDS.note, "");
  assert.deepEqual(DEFAULT_TWEET_FIELDS.images, []);
  assert.equal(DEFAULT_TWEET_FIELDS.truncated, false);
});

// ---------- prompt 构建 ----------
t("buildClassificationPrompt: 含全部维度与推文内容", () => {
  const msgs = buildClassificationPrompt(tweets[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.ok(msgs[0].content.includes("category") && msgs[0].content.includes("action"));
  assert.ok(msgs[1].content.includes("@alice") && msgs[1].content.includes("LLM"));
});

t("buildClassificationPrompt: 携带 contentType 作为上下文", () => {
  const withType = buildClassificationPrompt({ ...tweets[0], contentType: "视频" });
  assert.ok(withType[1].content.includes("内容类型: 视频"));
  const noType = buildClassificationPrompt(tweets[0]);
  assert.ok(!noType[1].content.includes("内容类型:"));
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
  assert.match(buildExport(tweets, "obsidian").filename, /obsidian.*\.md$/);
  assert.equal(buildExport(tweets, "obsidian").mimeType, "text/markdown");
});

// ---------- oEmbed 正文剥标签 ----------
t("stripOembedHtml: 剥标签并保留正文", () => {
  const html = `<blockquote class="twitter-tweet"><p lang="zh" dir="ltr">这是完整正文，<br>带换行 &amp; 实体</p>&mdash; Alice (@alice) <a href="https://twitter.com/alice/status/111">August 20, 2026</a></blockquote>`;
  const text = stripOembedHtml(html);
  assert.ok(text.includes("这是完整正文"));
  assert.ok(text.includes("带换行 & 实体"));
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("blockquote"));
});

t("stripOembedHtml: 去掉尾部署名行", () => {
  const html = `<blockquote class="twitter-tweet"><p>正文内容</p>&mdash; Alice (@alice) <a href="https://twitter.com/alice/status/111">August 20, 2026</a></blockquote>`;
  const text = stripOembedHtml(html);
  assert.equal(text, "正文内容");
});

t("stripOembedHtml: 空输入返回空串", () => {
  assert.equal(stripOembedHtml(""), "");
  assert.equal(stripOembedHtml(null), "");
});

// ---------- 图片 URL 尺寸替换 ----------
t("upgradeImageUrl: name=small 替换为 name=large", () => {
  assert.equal(
    upgradeImageUrl("https://pbs.twimg.com/media/abc.jpg?format=jpg&name=small"),
    "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large"
  );
});
t("upgradeImageUrl: name=360x360 替换为 name=large", () => {
  assert.equal(
    upgradeImageUrl("https://pbs.twimg.com/media/abc.jpg?format=jpg&name=360x360"),
    "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large"
  );
});
t("upgradeImageUrl: 无 name 参数时追加", () => {
  assert.equal(
    upgradeImageUrl("https://pbs.twimg.com/media/abc.jpg?format=jpg"),
    "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large"
  );
});
t("upgradeImageUrl: 非 pbs.twimg.com 原样返回", () => {
  assert.equal(upgradeImageUrl("https://example.com/a.png?name=small"), "https://example.com/a.png?name=small");
  assert.equal(upgradeImageUrl(""), "");
});

// ---------- 内容类型判定 ----------
t("detectContentType: 文章优先级最高", () => {
  assert.equal(detectContentType({ isArticle: true, hasVideo: true, imageCount: 2 }), "文章");
});
t("detectContentType: 视频 > 图片 > 文字", () => {
  assert.equal(detectContentType({ hasVideo: true, imageCount: 2 }), "视频");
  assert.equal(detectContentType({ imageCount: 3 }), "图片");
  assert.equal(detectContentType({}), "文字");
  assert.equal(detectContentType(), "文字");
});

// ---------- 已读过滤 ----------
t("matchesRead: 全部/已读/未读", () => {
  const read = { read: true };
  const unread = { read: false };
  const legacy = {}; // 旧数据无 read 字段视为未读
  assert.ok(matchesRead(read, "") && matchesRead(unread, "all"));
  assert.ok(matchesRead(read, "read") && !matchesRead(unread, "read"));
  assert.ok(matchesRead(unread, "unread") && !matchesRead(read, "unread"));
  assert.ok(matchesRead(legacy, "unread"));
});

// ---------- Obsidian 导出 ----------
t("toObsidian: frontmatter / callout / 图片内嵌 / 视频链接 / #tag", () => {
  const rich = [
    {
      id: "333",
      url: "https://x.com/carol/status/333",
      author: { name: "Carol", handle: "@carol" },
      content: "完整正文第一行\n第二行",
      publishedAt: "2026-08-22T10:00:00Z",
      category: "AI/技术",
      nature: "工具资源",
      contentType: "视频",
      mediaType: "video",
      tags: ["llm", "开源"],
      summary: "视频摘要",
      action: "稍后阅读",
      note: "我的备注\n第二行备注",
      read: true,
      images: ["https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large"],
    },
  ];
  const md = toObsidian(rich);
  // frontmatter 字段
  assert.ok(md.includes("id: 333"));
  assert.ok(md.includes("category: AI/技术"));
  assert.ok(md.includes("contentType: 视频"));
  assert.ok(md.includes("read: true"));
  assert.ok(md.includes("url: https://x.com/carol/status/333"));
  assert.ok(md.includes("tags: [llm, 开源]"));
  // 完整正文
  assert.ok(md.includes("完整正文第一行\n第二行"));
  // AI 摘要
  assert.ok(md.includes("**AI 摘要**：视频摘要"));
  // 备注 callout
  assert.ok(md.includes("> [!note] 备注"));
  assert.ok(md.includes("> 我的备注"));
  assert.ok(md.includes("> 第二行备注"));
  // 图片内嵌与视频链接
  assert.ok(md.includes("![](https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large)"));
  assert.ok(md.includes("▶ 视频：https://x.com/carol/status/333"));
  // #tag 形式
  assert.ok(md.includes("#llm #开源"));
  // 分组二级标题
  assert.ok(md.includes("## AI/技术（1）"));
});

t("toObsidian: 无备注/无媒体时不输出对应区块", () => {
  const md = toObsidian([tweets[1]]);
  assert.ok(!md.includes("[!note]"));
  assert.ok(!md.includes("![]("));
  assert.ok(!md.includes("▶ 视频"));
  assert.ok(md.includes("read: false"));
});

// ---------- 去重 Map 逻辑（与 content/scraper.js 相同模式） ----------
t("去重: Map 判重逻辑", () => {
  const scrapedIds = new Map();
  const incoming = [{ id: "1" }, { id: "2" }, { id: "1" }, { id: "3" }];
  const fresh = incoming.filter((x) => !scrapedIds.has(x.id) && (scrapedIds.set(x.id, true), true));
  assert.deepEqual(fresh.map((x) => x.id), ["1", "2", "3"]);
});

// ---------- LLM Wiki：配置归一化 ----------
t("normalizeWikiConfig: 空输入给默认配置", () => {
  assert.deepEqual(normalizeWikiConfig(null), { ...DEFAULT_WIKI_CONFIG });
  assert.equal(normalizeWikiConfig(undefined).enabled, false);
  assert.equal(normalizeWikiConfig({}).baseUrl, "http://127.0.0.1:19828");
});
t("normalizeWikiConfig: 非法值回退、合法值保留", () => {
  const c = normalizeWikiConfig({
    enabled: true,
    baseUrl: "http://localhost:9999/",
    autoSync: "smart",
    deepNatures: ["深度线程", "不存在"],
    minTextLength: 50, // 低于下限
    autoActions: ["待研究"],
  });
  assert.equal(c.enabled, true);
  assert.equal(c.baseUrl, "http://localhost:9999"); // 尾部斜杠被去掉
  assert.equal(c.autoSync, "smart");
  assert.deepEqual(c.deepNatures, ["深度线程"]);
  assert.equal(c.minTextLength, 100); // clamp 到下限
  assert.deepEqual(c.autoActions, ["待研究"]);
  assert.equal(normalizeWikiConfig({ autoSync: "乱填" }).autoSync, "manual");
});

// ---------- LLM Wiki：深度判定与分流 ----------
const deepByNature = { nature: "深度线程", content: "短" };
const deepByLength = { nature: "新闻快讯", content: "长".repeat(600) };
const lightTweet = { nature: "新闻快讯", content: "短内容" };
t("isDeepContent: Nature 命中或长度超阈值", () => {
  assert.ok(isDeepContent(deepByNature, DEFAULT_WIKI_CONFIG));
  assert.ok(isDeepContent(deepByLength, DEFAULT_WIKI_CONFIG));
  assert.ok(!isDeepContent(lightTweet, DEFAULT_WIKI_CONFIG));
});
t("routeProcessingMode: 四种策略路径", () => {
  const base = { ...DEFAULT_WIKI_CONFIG, enabled: true };
  assert.equal(routeProcessingMode(deepByNature, { ...base, autoSync: "manual" }), "light");
  assert.equal(routeProcessingMode(deepByNature, { ...base, autoSync: "smart" }), "pending");
  assert.equal(routeProcessingMode(deepByNature, { ...base, autoSync: "auto" }), "deep");
  assert.equal(routeProcessingMode(lightTweet, { ...base, autoSync: "auto" }), "light");
  assert.equal(routeProcessingMode(deepByNature, { ...base, enabled: false }), "light");
});

// ---------- LLM Wiki：推送载荷 ----------
t("buildWikiPagePayload: 字段齐全、externalId 为字符串", () => {
  const p = buildWikiPagePayload(tweets[0]);
  assert.equal(p.source, "x-bookmarks-exporter");
  assert.equal(p.externalId, "111");
  assert.equal(p.url, "https://x.com/alice/status/111");
  assert.deepEqual(p.tags, ["llm", "开源"]);
  assert.equal(p.title, "推荐一个 LLM 工具");
});
t("buildWikiPagePayload: 超长正文截断", () => {
  const p = buildWikiPagePayload({ id: "9", content: "x".repeat(WIKI_MAX_CONTENT_LENGTH + 100) });
  assert.ok(p.content.length <= WIKI_MAX_CONTENT_LENGTH + 20);
  assert.ok(p.content.includes("已截断"));
});

console.log(`\n全部通过：${passed} 项`);
