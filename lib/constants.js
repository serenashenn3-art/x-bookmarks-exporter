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
