# X 书签 AI 分类

Chrome 扩展（Manifest V3）：自动抓取 X（Twitter）书签，用 AI 分类打标，支持列表 / 分类汇总 / 行动看板三种视图浏览，以及 Markdown / JSON / CSV 多格式导出。

## 教学视频

https://github.com/user-attachments/assets/c669b14b-ac60-40fe-8a3b-808941182870

## 功能

- **一键抓取书签**：打开 X 书签页，点击右下角「AI 抓取书签」浮动按钮，自动滚动到底部并抓取全部推文（ID 去重）。
- **多 AI 提供商**：OpenAI、Claude、Gemini、Kimi（月之暗面）、通义千问、智谱 GLM、MiniMax、Ollama 本地；支持自定义 Base URL（代理或 OpenAI 兼容服务）。
- **AI 五维分类**：category（领域）、nature（性质）、tags（标签）、summary（摘要）、action（建议操作）；API 失败自动降级为「未分类」，不阻塞队列。
- **三种视图**：列表（搜索/筛选/排序）、分类汇总（按维度分组聚合 + 组内 AI 摘要）、行动看板（六栏拖拽变更状态）。
- **多格式导出**：按当前搜索筛选条件导出可见内容为 Markdown / JSON / CSV。

---

## 使用教学

### 第 1 步：安装扩展

1. 下载本仓库代码（`Code → Download ZIP` 后解压，或 `git clone`）。
2. 浏览器地址栏输入 `chrome://extensions` 并回车。
3. 打开页面右上角的「开发者模式」开关。
4. 点击左上角「加载已解压的扩展程序」，选择本项目文件夹。
5. 安装成功后会自动打开设置页；建议点击工具栏拼图图标，把本扩展**固定（Pin）**到工具栏方便使用。

> 无需安装任何依赖、无需构建，纯原生 JavaScript。

### 第 2 步：配置 AI 提供商

分类功能依赖一个 AI 接口。在设置页（安装后自动打开，或点 popup 右上角 ⚙ 进入）：

1. **选择 AI 提供商**（下拉框），然后填写对应的 **API Key**：

   | 提供商 | API Key 获取地址 | 备注 |
   |--------|------------------|------|
   | OpenAI | platform.openai.com → API keys | |
   | Claude | console.anthropic.com | |
   | Gemini | aistudio.google.com → Get API key | 有免费额度 |
   | Kimi（月之暗面） | platform.moonshot.cn | |
   | 通义千问 | bailian.console.aliyun.com | 阿里云百炼 |
   | 智谱 GLM | open.bigmodel.cn | |
   | MiniMax | platform.minimaxi.com | |
   | Ollama（本地） | 无需 Key | 需本机运行 `ollama serve` 并已拉取模型 |

2. **（可选）选择模型**：下拉框会列出该提供商的推荐模型，默认即可。
3. **（可选）自定义 Base URL**：走代理或使用 OpenAI 兼容的第三方服务时填写；留空用官方默认地址。填写后浏览器会弹窗请求该域名的访问权限，点「允许」。
4. 点击「**测试连接**」：显示绿色 ✓ 表示配置可用；红色 ✗ 请检查 Key、网络和 Base URL。
5. 点击「**保存**」。配置会存入 `chrome.storage.sync`，同一 Google 账号的多台设备自动同步。

### 第 3 步：抓取书签

1. 登录 X，打开书签页：`x.com/i/bookmarks`（twitter.com 域名同样支持）。
2. 页面**右下角**会出现「**AI 抓取书签**」浮动按钮，点击它。
3. 扩展开始自动向下滚动页面，边滚动边提取推文（推文 ID、正文、作者、时间、链接），并自动去重。
4. 滚动到没有更多内容后自动停止，弹出提示显示本次共抓取多少条。
5. 抓取到的推文会自动进入后台分类队列，逐条调用 AI 分类（每条间隔 0.5 秒防限流）。

> 书签很多时滚动抓取需要一些时间，期间请勿关闭该标签页。重复点击按钮不会产生重复数据（按推文 ID 去重）。

### 第 4 步：浏览与管理（Popup）

点击工具栏的扩展图标打开收藏界面：

**顶部工具栏**

- 🔍 **搜索框**：输入关键词实时匹配正文、作者、标签、摘要。
- **三个筛选下拉**：按领域 / 性质 / 建议操作过滤。
- **排序**：最新优先 / 最早优先 / 按领域 / 按作者。
- **分类中**时会显示进度条（如「正在分类 12/50」），新分类完成的书签会实时插入列表。

**三种视图（Tab 切换）**

| 视图 | 说明 |
|------|------|
| **列表** | 卡片流：作者、日期、彩色性质徽章、一句话摘要、标签、领域，点击链接跳回原推文 |
| **分类汇总** | 按维度（领域/性质/操作）分组折叠展示，每组显示数量；点击「生成组内摘要」可把同组推文聚合成一张汇总卡片 |
| **行动看板** | 按建议操作分六栏（稍后阅读/待研究/可引用/可试用/可分享/已归档），**拖拽卡片**即可变更状态 |

性质徽章配色：🟢 工具资源 · 🔵 教程指南 · 🟠 观点评论 · 🔴 新闻快讯 · 🟣 深度线程 · 🩵 灵感创意 · 🟡 待办行动 · ⚪ 归档资料

### 第 5 步：导出

在 popup 顶部点击 **Markdown / JSON / CSV** 按钮，浏览器会直接下载文件：

- **只导出当前可见内容**——先用搜索/筛选缩小范围，再点导出，即可实现「只导出 AI/技术类」这类按需导出。
- **Markdown**：按领域分组的二级标题结构，每条含摘要、作者、日期、标签、链接，适合导入 Notion / Obsidian。
- **JSON**：完整字段数组，适合备份或二次开发。
- **CSV**：Excel 可直接打开（带 UTF-8 BOM 防中文乱码），标签用分号分隔。

### 常见问题（FAQ）

**Q：点了抓取按钮没反应？**
先确认当前在 `x.com/i/bookmarks` 页面且已登录；刷新页面让 content script 重新注入；仍无效请到 `chrome://extensions` 看扩展是否报错。

**Q：分类全部显示「未分类」？**
说明 AI 调用失败。打开设置页点「测试连接」排查：API Key 是否正确、账户是否有余额、自定义 Base URL 是否可达。

**Q：抓取到一半浏览器把后台停了？**
分类队列已持久化，扩展被唤醒后会自动续跑；但大批量分类时建议保持浏览器运行。

**Q：抓取数量比实际书签少？**
X 的页面结构偶尔改版。如果明显漏抓，是 DOM 选择器失效，需要更新 `content/scraper.js`，欢迎提 Issue。

**Q：数据存在哪里？会上传吗？**
书签数据存在本地 `chrome.storage.local`；只有推文文本会发送给**你自己配置**的 AI 服务商，扩展不经过任何第三方服务器。

---

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
