# X 书签 AI 分类

Chrome 扩展（Manifest V3）：自动抓取 X（Twitter）书签，用 AI 分类打标，支持列表 / 分类汇总 / 行动看板三种视图浏览，以及 Markdown / JSON / CSV 多格式导出。

## 功能

- **一键抓取书签**：打开 X 书签页，点击右下角「AI 抓取书签」浮动按钮，自动滚动到底部并抓取全部推文（ID 去重）。
- **多 AI 提供商**：OpenAI、Claude、Gemini、Kimi（月之暗面）、通义千问、智谱 GLM、MiniMax、Ollama 本地；支持自定义 Base URL（代理或 OpenAI 兼容服务）。
- **AI 五维分类**：category（领域）、nature（性质）、tags（标签）、summary（摘要）、action（建议操作）；API 失败自动降级为「未分类」，不阻塞队列。
- **三种视图**：列表（搜索/筛选/排序）、分类汇总（按维度分组聚合 + 组内 AI 摘要）、行动看板（六栏拖拽变更状态）。
- **多格式导出**：按当前搜索筛选条件导出可见内容为 Markdown / JSON / CSV。

## 安装

1. 下载本仓库代码。
2. 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录。
4. 首次安装会自动打开设置页。

无构建步骤、无 npm 依赖，纯原生 JavaScript（ES Module）。

## 配置

1. 打开设置页（扩展图标 → 详情 → 扩展程序选项，或首次安装自动打开）。
2. 选择 AI 提供商，填写对应 API Key（Ollama 本地无需 Key）。
3. 可选：选择模型、填写自定义 Base URL（会按需请求该域名权限）。
4. 点击「测试连接」验证可用性，然后「保存」。

## 使用

1. 访问 `x.com/i/bookmarks`（或 twitter.com 书签页）。
2. 点击右下角「AI 抓取书签」，等待自动滚动抓取完成。
3. 点击工具栏扩展图标打开 popup：搜索、筛选、切换三种视图、导出。

## 架构

```
x-bookmark-ai/
├── manifest.json            MV3 清单（popup + module SW + content script）
├── background/
│   └── index.js             Service Worker：分类队列（storage.session 持久化、可断点续跑）、消息路由、导出下载、旧数据迁移
├── content/
│   └── scraper.js           书签页抓取：浮动按钮、自动滚动、DOM 提取、Map 去重（自包含 classic script）
├── popup/
│   ├── popup.html/css/js    收藏界面：搜索筛选排序 + 列表/分类汇总/行动看板三视图 + 实时进度
├── options/
│   ├── options.html/js      设置页：提供商选择、API Key、模型、自定义 Base URL、测试连接
└── lib/
    ├── constants.js         分类维度枚举与默认值
    ├── ai-providers.js      8 家 AI 提供商适配器（鉴权/请求体/响应解析标准化）
    ├── prompt.js            统一分类 Prompt + JSON 容错解析
    ├── export.js            Markdown / JSON / CSV 生成
    └── storage.js           chrome.storage 封装（单条键存储 + 旧数据迁移）
```

## 数据与隐私

- 书签存 `chrome.storage.local`（推文 ID 为键单条存储）；AI 配置存 `chrome.storage.sync`（随账号同步）。
- 仅推文文本会发送给你配置的 AI API，API Key 只直连对应服务商域名。

## 已知限制

- X 的 DOM 结构（`data-testid="tweet"` 等选择器）可能随官方改版失效，届时需更新 `content/scraper.js`。
- Service Worker 空闲会被终止：分类队列已持久化到 `chrome.storage.session`，唤醒后继续；但大批量分类请保持浏览器运行。
- data URI 导出在数据量极大（数万条）时可能受 Chrome 下载限制。

## License

MIT
