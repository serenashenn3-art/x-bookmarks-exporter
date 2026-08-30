/**
 * lib/constants.js — 全局常量：分类维度枚举与默认值
 * 纯 ES Module，不依赖 chrome API，可被 background / popup / options / Node 测试引用。
 */

export const UNCATEGORIZED = "未分类";

/** 领域分类 */
export const CATEGORIES = [
  "AI/技术",
  "产品/设计",
  "商业/投资",
  "生活/随笔",
  "新闻/资讯",
  "工具/资源",
  "教程/指南",
  "观点/评论",
];

/** 内容性质 */
export const NATURES = [
  "工具资源",
  "教程指南",
  "观点评论",
  "新闻快讯",
  "深度线程",
  "灵感创意",
  "待办行动",
  "归档资料",
];

/** 建议操作 */
export const ACTIONS = [
  "稍后阅读",
  "待研究",
  "可引用",
  "可试用",
  "可分享",
  "已归档",
];

/** 性质徽章配色（popup 列表视图使用） */
export const NATURE_COLORS = {
  工具资源: "#22a06b", // 绿
  教程指南: "#3b82f6", // 蓝
  观点评论: "#f97316", // 橙
  新闻快讯: "#ef4444", // 红
  深度线程: "#8b5cf6", // 紫
  灵感创意: "#14b8a6", // 青
  待办行动: "#eab308", // 黄
  归档资料: "#9ca3af", // 灰
  [UNCATEGORIZED]: "#d1d5db", // 浅灰
};

/** AI 分类失败 / 旧数据迁移时的默认分类字段 */
export const DEFAULT_CLASSIFICATION = Object.freeze({
  category: UNCATEGORIZED,
  nature: UNCATEGORIZED,
  tags: [],
  summary: "",
  action: "稍后阅读",
  classifiedAt: null,
});

/** 内容类型（scraper 依据 DOM 特征判定，不经过 AI） */
export const CONTENT_TYPES = ["文章", "视频", "图片", "文字"];

/** 内容类型徽章配色（popup 列表视图使用） */
export const CONTENT_TYPE_COLORS = {
  文章: "#8b5cf6", // 紫
  视频: "#ef4444", // 红
  图片: "#14b8a6", // 青
  文字: "#9ca3af", // 灰
};

/** 书签的非分类默认字段（抓取元数据 + 用户状态），新条目录入与旧数据迁移时补齐 */
export const DEFAULT_TWEET_FIELDS = Object.freeze({
  contentType: "文字",
  mediaType: null, // "video" | "photo" | null
  images: [],
  truncated: false, // 时间线正文被 X 截断（有「显示更多」）
  fullTextFailed: false, // oEmbed 全文补全失败
  note: "",
  noteUpdatedAt: null,
  read: false,
  // === LLM Wiki 深度模式字段 ===
  processingMode: "light", // "light" 仅本地轻量 | "pending" 待确认推送 | "deep" 已入/待入知识库
  wikiSynced: false, // 是否已成功推送到 LLM Wiki
  wikiPageUrl: null, // 推送成功后 Wiki 返回的页面地址
  wikiSyncError: null, // 最近一次推送失败原因（成功或重试前清空）
});

/** LLM Wiki 分流策略 */
export const WIKI_AUTO_SYNC_MODES = ["manual", "smart", "auto"];

/** LLM Wiki 配置默认值（chrome.storage.sync 持久化） */
export const DEFAULT_WIKI_CONFIG = Object.freeze({
  enabled: false, // 总开关：不启用时扩展保持纯轻量模式
  baseUrl: "http://127.0.0.1:19828", // 本地 LLM Wiki 服务地址
  autoSync: "manual", // manual 全部手动 | smart 智能推荐待确认 | auto 深度内容自动推送
  deepNatures: ["深度线程", "教程指南"], // 自动判定为深度内容的 Nature
  minTextLength: 500, // 正文超过该长度（字符）自动判定为深度
  autoActions: ["待研究", "可引用"], // 看板拖入这些列时自动触发同步
});
