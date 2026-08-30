/**
 * popup/popup.js — 收藏界面：搜索/筛选/排序 + 列表 / 分类汇总 / 行动看板三视图
 */

import {
  CATEGORIES,
  NATURES,
  ACTIONS,
  CONTENT_TYPES,
  NATURE_COLORS,
  CONTENT_TYPE_COLORS,
  UNCATEGORIZED,
} from "../lib/constants.js";

// ==================== 状态 ====================

let tweets = []; // 当前筛选条件下的可见推文
let activeView = "list";
let groupDim = "category";
let wikiConfig = null; // LLM Wiki 配置（null = 尚未加载）
let batchMode = false;
const selectedIds = new Set();

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const send = (msg) => chrome.runtime.sendMessage(msg);

function currentFilter() {
  return {
    search: $("search").value.trim(),
    category: $("filterCategory").value,
    nature: $("filterNature").value,
    actionFilter: activeView === "kanban" ? "" : $("filterAction").value,
    contentType: $("filterContentType").value,
    readFilter: $("filterRead").value,
    sort: $("sort").value,
  };
}

// ==================== 数据加载 ====================

async function reload() {
  const r = await send({ action: "getTweets", filter: currentFilter() });
  tweets = r?.tweets || [];
  $("count").textContent = `${tweets.length} / ${r?.total ?? tweets.length} 条`;
  renderActiveView();
}

// ==================== Toast 轻提示 ====================

let toastTimer = null;
function showToast(text, ms = 2500) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ==================== 渲染：列表视图 ====================

function natureBadge(nature) {
  const n = nature || UNCATEGORIZED;
  const color = NATURE_COLORS[n] || "#d1d5db";
  return `<span class="badge" style="background:${color}">${esc(n)}</span>`;
}

function contentTypeBadge(contentType) {
  const c = contentType || "文字";
  const color = CONTENT_TYPE_COLORS[c] || "#9ca3af";
  return `<span class="ctype-badge" style="background:${color}">${esc(c)}</span>`;
}

function tweetCard(t) {
  const date = (t.publishedAt || "").slice(0, 10);
  const tags = (t.tags || []).map((tag) => `#${esc(tag)}`).join(" ");
  const div = document.createElement("div");
  // Wiki 同步状态反映在卡片左边框上
  const wikiClass = t.wikiSynced ? " wiki-synced" : t.wikiSyncError ? " wiki-error" : t.processingMode === "pending" ? " wiki-pending" : "";
  div.className = "card" + (t.read ? " read" : "") + wikiClass + (batchMode ? " batch" : "");
  div.dataset.id = t.id;
  const wikiEnabled = !!wikiConfig?.enabled;
  div.innerHTML = `
    <div class="card-head">
      <span class="author">${esc(t.author?.name || "未知作者")}</span>
      <span class="handle">${esc(t.author?.handle || "")}</span>
      <span class="date">${esc(date)}</span>
      ${contentTypeBadge(t.contentType)}
      ${natureBadge(t.nature)}
      ${t.wikiSynced ? `<span class="wiki-badge synced" title="已同步到 LLM Wiki${t.wikiPageUrl ? "：" + esc(t.wikiPageUrl) : ""}">🧠</span>` : ""}
      ${!t.wikiSynced && t.processingMode === "pending" ? `<span class="wiki-badge pending" title="AI 判定为深度内容，待确认推送">⏳</span>` : ""}
      ${t.wikiSyncError ? `<span class="wiki-badge error" title="同步失败：${esc(t.wikiSyncError)}">⚠</span>` : ""}
    </div>
    <div class="summary">${esc(t.summary || (t.content || "").slice(0, 80))}</div>
    ${t.content ? `<div class="fulltext${t.contentType === "文章" ? "" : " hidden"}">${esc(t.content)}</div>` : ""}
    ${t.note ? `<div class="note-text">${esc(t.note)}</div>` : ""}
    <div class="note-editor hidden">
      <textarea placeholder="添加备注…">${esc(t.note || "")}</textarea>
      <button class="note-save">保存备注</button>
    </div>
    <div class="card-foot">
      <span class="tags">${tags}</span>
      <span>${esc(t.category || UNCATEGORIZED)}</span>
      ${t.content ? `<button class="fulltext-btn">${t.contentType === "文章" ? "收起全文" : "展开全文"}</button>` : ""}
      <button class="note-btn" title="备注">备注</button>
      <button class="read-btn${t.read ? " done" : ""}" title="切换已读状态">${t.read ? "已读" : "未读"}</button>
      ${wikiEnabled && !t.wikiSynced && t.processingMode !== "pending" ? `<button class="wiki-btn" title="存入 LLM Wiki 知识库">🧠 存知识库</button>` : ""}
      ${wikiEnabled && t.processingMode === "pending" ? `<button class="wiki-confirm-btn" title="确认推送到 LLM Wiki">✅ 推送</button><button class="wiki-reject-btn" title="保持轻量模式">❌</button>` : ""}
      <button class="delete-btn" data-id="${esc(t.id)}" title="删除">✕</button>
      <a class="origin-link" href="${esc(t.url)}" target="_blank" rel="noopener">原文 ↗</a>
    </div>
    <label class="card-select${batchMode ? "" : " hidden"}" title="选择">
      <input type="checkbox" class="batch-checkbox" data-id="${esc(t.id)}"${selectedIds.has(t.id) ? " checked" : ""}>
    </label>`;

  div.querySelector(".delete-btn").addEventListener("click", async (e) => {
    await send({ action: "deleteTweet", tweetId: e.target.dataset.id });
    reload();
  });

  // 备注：展开/收起编辑区，保存后写库
  const editor = div.querySelector(".note-editor");
  div.querySelector(".note-btn").addEventListener("click", () => editor.classList.toggle("hidden"));
  div.querySelector(".note-save").addEventListener("click", async () => {
    const note = editor.querySelector("textarea").value.trim();
    const r = await send({ action: "updateNote", tweetId: t.id, note });
    if (r?.success) {
      t.note = note;
      reload();
    }
  });

  // 全文展开/收起
  const ftBtn = div.querySelector(".fulltext-btn");
  if (ftBtn) {
    ftBtn.addEventListener("click", () => {
      const ft = div.querySelector(".fulltext");
      ft.classList.toggle("hidden");
      ftBtn.textContent = ft.classList.contains("hidden") ? "展开全文" : "收起全文";
    });
  }

  // 已读/未读切换
  div.querySelector(".read-btn").addEventListener("click", async () => {
    const r = await send({ action: "markRead", tweetId: t.id, read: !t.read });
    if (r?.success) {
      t.read = !t.read;
      renderActiveView();
    }
  });

  // 打开原文时自动标记已读
  div.querySelector(".origin-link").addEventListener("click", () => {
    if (!t.read) send({ action: "markRead", tweetId: t.id, read: true });
  });

  // 单条「存知识库」/ smart 模式确认推送
  const pushWiki = async () => {
    showToast(`正在同步「${(t.summary || t.content || "").slice(0, 20)}…」到 LLM Wiki`, 6000);
    const r = await send({ action: "syncToWiki", tweetId: t.id });
    showToast(r?.success ? "✓ 已同步到 LLM Wiki" : `✗ 同步失败：${r?.error || "未知错误"}`);
  };
  div.querySelector(".wiki-btn")?.addEventListener("click", pushWiki);
  div.querySelector(".wiki-confirm-btn")?.addEventListener("click", pushWiki);

  // smart 模式拒绝推送：保持轻量
  div.querySelector(".wiki-reject-btn")?.addEventListener("click", async () => {
    const r = await send({
      action: "updateWikiStatus",
      tweetId: t.id,
      status: { processingMode: "light", wikiSyncError: null },
    });
    if (r?.success) {
      t.processingMode = "light";
      renderActiveView();
    }
  });

  // 批量模式复选框
  div.querySelector(".batch-checkbox")?.addEventListener("change", (e) => {
    if (e.target.checked) selectedIds.add(t.id);
    else selectedIds.delete(t.id);
    updateBatchCount();
  });
  return div;
}

function renderList() {
  const view = $("view-list");
  view.innerHTML = "";
  if (!tweets.length) {
    view.innerHTML = `<div class="empty">暂无书签。到 X 书签页点击右下角「AI 抓取书签」按钮开始。</div>`;
    return;
  }
  tweets.forEach((t) => view.appendChild(tweetCard(t)));
}

// ==================== 渲染：分类汇总视图 ====================

function renderGroup() {
  const container = $("groupContainer");
  container.innerHTML = "";
  if (!tweets.length) {
    container.innerHTML = `<div class="empty">暂无数据</div>`;
    return;
  }
  const groups = new Map();
  for (const t of tweets) {
    const key = t[groupDim] || UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t); // tweets 已按排序（默认时间倒序）
  }

  for (const [name, items] of groups) {
    const g = document.createElement("div");
    g.className = "group";
    g.innerHTML = `
      <div class="group-header">
        <span class="arrow">▶</span>
        <strong>${esc(name)}</strong>
        <span class="group-count">${items.length} 条</span>
        <button class="group-summary-btn">生成组内摘要</button>
      </div>
      <div class="group-body"></div>`;

    const header = g.querySelector(".group-header");
    const body = g.querySelector(".group-body");
    header.addEventListener("click", () => g.classList.toggle("open"));

    g.querySelector(".group-summary-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "生成中…";
      const r = await send({
        action: "summarizeGroup",
        tweetIds: items.map((t) => t.id),
        groupName: name,
      });
      btn.disabled = false;
      btn.textContent = "生成组内摘要";
      let card = body.querySelector(".group-summary-card");
      if (!card) {
        card = document.createElement("div");
        card.className = "group-summary-card";
        body.prepend(card);
      }
      card.textContent = r?.success ? r.summary : `生成失败：${r?.error || "未知错误"}`;
      g.classList.add("open");
    });

    items.forEach((t) => {
      const item = document.createElement("div");
      item.className = "group-item";
      const date = (t.publishedAt || "").slice(0, 10);
      item.innerHTML = `${esc(t.summary || (t.content || "").slice(0, 60))}
        <div class="handle">${esc(t.author?.handle || "")} · ${esc(date)} · <a href="${esc(t.url)}" target="_blank" rel="noopener">原文 ↗</a></div>`;
      // 打开原文时自动标记已读
      item.querySelector("a").addEventListener("click", () => {
        if (!t.read) send({ action: "markRead", tweetId: t.id, read: true });
      });
      body.appendChild(item);
    });

    container.appendChild(g);
  }
}

// ==================== 渲染：行动看板视图 ====================

function renderKanban() {
  const board = $("kanbanBoard");
  board.innerHTML = "";
  for (const action of ACTIONS) {
    const col = document.createElement("div");
    col.className = "kanban-col";
    col.dataset.action = action;
    const items = tweets.filter((t) => (t.action || "稍后阅读") === action);
    col.innerHTML = `<h4><span>${esc(action)}</span><span>${items.length}</span></h4>`;

    items.forEach((t) => {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.draggable = true;
      card.dataset.id = t.id;
      card.innerHTML = `
        <div>${esc(t.summary || (t.content || "").slice(0, 60))}</div>
        <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.author?.handle || "")} ↗</a>`;
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      });
      col.appendChild(card);
    });

    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("dragover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const id = e.dataTransfer.getData("text/plain");
      const newAction = col.dataset.action;
      const t = tweets.find((x) => x.id === id);
      if (!t || t.action === newAction) return;
      t.action = newAction; // 乐观更新
      renderKanban();
      await send({ action: "updateTweetAction", tweetId: id, newAction });
    });

    board.appendChild(col);
  }
}

// ==================== 批量模式（推送到 LLM Wiki） ====================

function toggleBatchMode(enabled) {
  batchMode = enabled;
  selectedIds.clear();
  $("batchToolbar").classList.toggle("hidden", !enabled);
  updateBatchCount();
  renderActiveView(); // 重渲染以显示/隐藏卡片复选框
}

function updateBatchCount() {
  $("batchCount").textContent = selectedIds.size;
  $("batchWikiBtn").disabled = selectedIds.size === 0;
}

async function batchPushToWiki() {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  showToast(`开始批量同步 ${ids.length} 条…`, 6000);
  const r = await send({ action: "batchSyncToWiki", tweetIds: ids });
  if (!r?.success) showToast(`✗ 批量同步失败：${r?.error || "未知错误"}`);
  toggleBatchMode(false);
  // 进度与结果通过 wikiSyncProgress / wikiSyncDone 广播更新
}

// ==================== 视图切换与事件 ====================

function renderActiveView() {
  if (activeView === "list") renderList();
  else if (activeView === "group") renderGroup();
  else renderKanban();
}

function fillSelect(el, options) {
  options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    el.appendChild(opt);
  });
}

function initToolbar() {
  fillSelect($("filterCategory"), CATEGORIES.concat(UNCATEGORIZED));
  fillSelect($("filterNature"), NATURES.concat(UNCATEGORIZED));
  fillSelect($("filterAction"), ACTIONS);
  fillSelect($("filterContentType"), CONTENT_TYPES);

  let searchTimer = null;
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 250); // 实时搜索（防抖）
  });
  ["filterCategory", "filterNature", "filterAction", "filterContentType", "filterRead", "sort"].forEach((id) =>
    $(id).addEventListener("change", reload)
  );
  $("groupDim").addEventListener("change", (e) => {
    groupDim = e.target.value;
    renderGroup();
  });

  $("settingsBtn").addEventListener("click", () => send({ action: "openOptions" }));

  // 批量模式
  $("batchBtn").addEventListener("click", () => {
    if (!wikiConfig?.enabled) {
      showToast("请先在设置页启用 LLM Wiki 深度模式");
      return;
    }
    toggleBatchMode(!batchMode);
  });
  $("batchCancelBtn").addEventListener("click", () => toggleBatchMode(false));
  $("batchWikiBtn").addEventListener("click", batchPushToWiki);

  $("reclassifyBtn").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const r = await send({ action: "reclassify" });
      btn.textContent = r?.success ? `已入队 ${r.queued} 条` : `失败: ${r?.error || "未知"}`;
    } catch (err) {
      btn.textContent = `失败: ${err.message}`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "重分类";
      }, 3000);
    }
  });

  document.querySelectorAll(".export-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const r = await send({ action: "exportTweets", format: btn.dataset.format, filter: currentFilter() });
      if (!r?.success) alert(r?.error || "导出失败");
    })
  );

  $("clearAllBtn").addEventListener("click", async () => {
    if (!confirm("确定清空全部书签？此操作不可恢复。")) return;
    if (!confirm("再次确认：将删除所有书签及其分类、备注，是否继续？")) return;
    const r = await send({ action: "clearAll" });
    if (r?.success) reload();
    else alert(r?.error || "清空失败");
  });

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      activeView = tab.dataset.view;
      ["list", "group", "kanban"].forEach((v) =>
        $(`view-${v}`).classList.toggle("hidden", v !== activeView)
      );
      reload();
    })
  );
}

// ==================== 实时进度 ====================

function showProgress(done, total) {
  const el = $("progress");
  if (!total) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.textContent = `正在分类 ${done}/${total}…`;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "classifyProgress") {
    if (message.finished) {
      showProgress(0, 0);
      reload();
    } else {
      showProgress(message.done, message.total);
    }
  } else if (message.action === "tweetClassified") {
    // 动态插入 / 更新卡片
    const idx = tweets.findIndex((t) => t.id === message.tweet?.id);
    if (idx >= 0) {
      tweets[idx] = message.tweet;
      renderActiveView();
    }
  } else if (message.action === "scrapeComplete") {
    reload();
  } else if (message.action === "wikiSyncProgress") {
    if (message.finished) {
      if (message.total === 0) reload(); // 队列跑完，刷新显示最终同步状态
    } else if (message.total > 1) {
      showToast(`LLM Wiki 同步进度：${message.done}/${message.total}`, 4000);
    }
  } else if (message.action === "wikiSyncDone") {
    // 同步完成（成功/失败）：就地更新卡片状态
    const idx = tweets.findIndex((t) => t.id === message.tweet?.id);
    if (idx >= 0) {
      tweets[idx] = message.tweet;
      renderActiveView();
    }
  }
});

// ==================== 启动 ====================

initToolbar();
(async () => {
  const r = await send({ action: "getWikiConfig" }); // 先拿 Wiki 配置，决定卡片是否渲染 Wiki 按钮
  wikiConfig = r?.config || null;
  reload();
  send({ action: "getProgress" }).then((p) => {
    if (p?.total) showProgress(p.done, p.total);
  });
})();
