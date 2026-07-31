// 历史记录：列表 + 搜索 + 筛选 + 详情展开
import { fetchJSON } from "../lib/fetch.js";
import { escape, highlight, renderDiff } from "../lib/escape.js";
import { fmtNum, fmtTime, fmtSeconds } from "../lib/format.js";
import { setupDropdown } from "../lib/dropdown.js";
import { setupCalendarPopover } from "../lib/calendar.js";

const PAGE_SIZE = 50;

let historyOffset = 0;
let historyHasMore = true;
let historyQuery = "";
let historyClient = "all";
let historySince = "";
let historyUntil = "";
let historyPostProc = "all";
let knownClients = [];

let historyClientDD = null;
let historyPostDD = null;
let searchTimer = null;

export async function mount() {
  // 加载更多
  document.getElementById("load-more-btn").addEventListener("click", () => loadHistory(false));

  // 搜索
  const searchInput = document.getElementById("history-search");
  const searchClear = document.getElementById("history-search-clear");
  searchInput.addEventListener("input", () => {
    const v = searchInput.value.trim();
    searchClear.hidden = v === "";
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      historyQuery = v;
      loadHistory(true);
    }, 300);
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    historyQuery = "";
    loadHistory(true);
    searchInput.focus();
  });

  setupHistoryFilters();
  await loadHistoryClientOptions();
  await loadHistory(true);
}

export function unmount() {
  clearTimeout(searchTimer);
}

function buildHistoryParams() {
  const p = new URLSearchParams({ n: PAGE_SIZE, offset: historyOffset });
  if (historyQuery) p.set("q", historyQuery);
  if (historyClient && historyClient !== "all") p.set("client", historyClient);
  if (historySince) p.set("since", historySince);
  if (historyUntil) p.set("until", historyUntil);
  if (historyPostProc !== "all") p.set("post_processed", historyPostProc);
  return p.toString();
}

function activeFilterCount() {
  let n = 0;
  if (historyQuery) n++;
  if (historyClient !== "all") n++;
  if (historySince || historyUntil) n++;
  if (historyPostProc !== "all") n++;
  return n;
}

async function loadHistory(reset = true) {
  if (reset) {
    historyOffset = 0;
    historyHasMore = true;
    document.getElementById("recent-list").innerHTML = "";
  }
  if (!historyHasMore) return;

  const items = await fetchJSON(`/api/stats/recent?${buildHistoryParams()}`);
  appendHistoryItems(items);
  historyOffset += items.length;
  historyHasMore = items.length === PAGE_SIZE;

  const btn = document.getElementById("load-more-btn");
  btn.disabled = !historyHasMore;
  btn.textContent = historyHasMore ? "加载更多" : "没有更多了";

  const hasFilter = activeFilterCount() > 0;
  const ul = document.getElementById("recent-list");
  if (historyOffset === 0 && hasFilter) {
    ul.innerHTML = `<li class="muted" style="padding:14px">没有匹配的记录。</li>`;
  }

  const parts = [];
  if (historyQuery) parts.push(`「${historyQuery}」`);
  if (historyClient !== "all") parts.push(historyClient);
  if (historySince || historyUntil) {
    parts.push(`${historySince || "…"} → ${historyUntil || "…"}`);
  }
  if (historyPostProc === "1") parts.push("已后处理");
  else if (historyPostProc === "0") parts.push("未后处理");
  document.getElementById("history-count").textContent =
    parts.length
      ? `${parts.join(" · ")} → ${historyOffset} 条`
      : `已加载 ${historyOffset} 条`;

  document.getElementById("filter-reset").hidden = !hasFilter;
}

async function loadHistoryClientOptions() {
  const list = await fetchJSON("/api/stats/clients");
  knownClients = list;
  const items = [{ value: "all", label: "全部" }, ...list.map((c) => ({ value: c, label: c }))];
  if (historyClientDD) {
    historyClientDD.setItems(items, historyClient);
  } else {
    historyClientDD = setupDropdown({
      rootId: "history-client-dd",
      labelId: "history-client-label",
      items,
      initialValue: historyClient,
      onChange: (v) => {
        historyClient = v;
        loadHistory(true);
      },
    });
  }
}

function setupHistoryFilters() {
  // 后处理筛选
  if (!historyPostDD) {
    historyPostDD = setupDropdown({
      rootId: "history-post-dd",
      labelId: "history-post-label",
      items: [
        { value: "all", label: "全部" },
        { value: "1", label: "已后处理" },
        { value: "0", label: "未后处理" },
      ],
      initialValue: historyPostProc,
      onChange: (v) => {
        historyPostProc = v;
        loadHistory(true);
      },
    });
  }

  // 日期范围
  const sinceEl = document.getElementById("history-since");
  const untilEl = document.getElementById("history-until");
  const dateClear = document.getElementById("date-clear");

  const fmtDateLabel = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${y}-${m}-${d}`;
  };

  const syncTriggerLabel = (trigger) => {
    const targetId = trigger.dataset.target;
    const hidden = document.getElementById(targetId);
    const labelEl = trigger.querySelector(".date-trigger-label");
    if (hidden.value) {
      labelEl.textContent = fmtDateLabel(hidden.value);
      trigger.classList.add("has-value");
    } else {
      labelEl.textContent = labelEl.dataset.placeholder;
      trigger.classList.remove("has-value");
    }
  };

  const onDateChange = () => {
    historySince = sinceEl.value || "";
    historyUntil = untilEl.value || "";
    dateClear.hidden = !(historySince || historyUntil);
    document.querySelectorAll(".date-trigger").forEach(syncTriggerLabel);
    loadHistory(true);
  };

  setupCalendarPopover({ onChange: onDateChange });

  dateClear.addEventListener("click", (e) => {
    e.stopPropagation();
    sinceEl.value = "";
    untilEl.value = "";
    historySince = "";
    historyUntil = "";
    dateClear.hidden = true;
    document.querySelectorAll(".date-trigger").forEach(syncTriggerLabel);
    loadHistory(true);
  });

  document.getElementById("filter-reset").addEventListener("click", () => {
    document.getElementById("history-search").value = "";
    document.getElementById("history-search-clear").hidden = true;
    sinceEl.value = "";
    untilEl.value = "";
    dateClear.hidden = true;
    document.querySelectorAll(".date-trigger").forEach(syncTriggerLabel);
    historyQuery = "";
    historyClient = "all";
    historySince = "";
    historyUntil = "";
    historyPostProc = "all";
    historyClientDD && historyClientDD.setItems(
      [{ value: "all", label: "全部" }, ...knownClients.map((c) => ({ value: c, label: c }))],
      "all",
    );
    historyPostDD && historyPostDD.setItems(
      [
        { value: "all", label: "全部" },
        { value: "1", label: "已后处理" },
        { value: "0", label: "未后处理" },
      ],
      "all",
    );
    loadHistory(true);
  });
}

function appendHistoryItems(items) {
  const ul = document.getElementById("recent-list");
  ul.classList.toggle("in-search", !!historyQuery);

  if (historyOffset === 0 && items.length === 0) {
    ul.innerHTML = '<li class="muted" style="padding:14px">还没有转录记录。</li>';
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "recent-item" + (item.error ? " has-error" : "");
    li.dataset.id = item.id;

    const durLabel = item.audio_duration ? `${item.audio_duration.toFixed(1)}s` : "—";
    const clientLabel = item.client_host || item.client_ip || "unknown";
    const isModified = item.post_processed === 1;

    let previewHtml;
    if (item.error) {
      previewHtml = highlight(item.error, historyQuery);
    } else if (isModified) {
      previewHtml = renderDiff(item.text_raw, item.text_final);
    } else {
      previewHtml = highlight(item.text_final || "(空)", historyQuery);
    }

    li.innerHTML = `
      <div class="recent-head">
        <div class="recent-meta-line">
          <span class="recent-date">${fmtTime(item.created_at)}</span>
          <span class="recent-client">${escape(clientLabel)}</span>
          ${isModified ? '<span class="modified-tag">已后处理</span>' : ""}
          ${item.error ? '<span class="error-tag">失败</span>' : ""}
        </div>
        <span class="recent-duration">${durLabel}</span>
      </div>
      <div class="recent-text">${previewHtml}</div>
      <div class="recent-detail"></div>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest("audio, .btn-copy, .diff-tab")) return;
      toggleDetail(li, item);
    });
    ul.appendChild(li);
  }
}

function toggleDetail(li, item) {
  if (li.classList.contains("expanded")) {
    li.classList.remove("expanded");
    return;
  }
  li.classList.add("expanded");
  const detailEl = li.querySelector(".recent-detail");
  if (detailEl.dataset.loaded === "1") return;

  const sameRaw = item.text_raw === item.text_final;
  let html = "";

  if (item.error) {
    html += `
      <div class="detail-section">
        <div class="detail-section-head">
          <span class="detail-label">错误信息</span>
        </div>
        <div class="detail-text-raw">${escape(item.error)}</div>
      </div>`;
  } else {
    if (item.text_final) {
      if (sameRaw) {
        html += `
          <div class="detail-section">
            <div class="detail-section-head">
              <span class="detail-label">转录文本</span>
              <button class="btn-copy" type="button">⧉ 复制</button>
            </div>
            <div class="detail-text">${highlight(item.text_final, historyQuery)}</div>
          </div>`;
      } else {
        html += `
          <div class="detail-section">
            <div class="detail-section-head">
              <div class="detail-tabs" role="tablist">
                <button class="diff-tab" data-view="diff" aria-selected="true" type="button">差异对比</button>
                <button class="diff-tab" data-view="raw" type="button">原始</button>
                <button class="diff-tab" data-view="final" type="button">后处理</button>
              </div>
              <button class="btn-copy" type="button">⧉ 复制</button>
            </div>
            <div class="detail-text" data-text-block>${renderDiff(item.text_raw || "", item.text_final)}</div>
          </div>`;
      }
    }
    html += `
      <div class="detail-section">
        <audio controls preload="none" src="/api/recordings/${item.id}/audio"></audio>
      </div>`;
  }

  const metaRows = [
    ["⏱", "ASR 推理", fmtSeconds(item.inference_ms)],
    ["🔧", "后处理", item.postprocess_ms ? fmtSeconds(item.postprocess_ms) : "—"],
    ["⌨", "节省击键", `${fmtNum(item.keystroke_count)}`],
    ["#", "字数", `${fmtNum(item.char_count)}`],
    ["⚙", "模型", escape(item.model_name || "—")],
  ];
  html += `
    <div class="detail-section">
      <div class="detail-meta">
        ${metaRows
          .map(
            ([icon, label, value]) => `
          <div class="meta-stat">
            <span class="detail-meta-icon">${icon}</span>
            <span class="meta-label">${label}</span>
            <span class="meta-value">${value}</span>
          </div>`,
          )
          .join("")}
      </div>
    </div>`;

  detailEl.innerHTML = html;
  detailEl.dataset.loaded = "1";

  detailEl.querySelectorAll(".diff-tab").forEach((tab) => {
    tab.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const view = tab.dataset.view;
      detailEl.querySelectorAll(".diff-tab").forEach((t) =>
        t.setAttribute("aria-selected", t === tab ? "true" : "false"),
      );
      const block = detailEl.querySelector("[data-text-block]");
      if (!block) return;
      if (view === "diff") {
        block.innerHTML = renderDiff(item.text_raw || "", item.text_final);
      } else if (view === "raw") {
        block.innerHTML = highlight(item.text_raw || "", historyQuery);
      } else {
        block.innerHTML = highlight(item.text_final, historyQuery);
      }
    });
  });

  detailEl.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      let text = item.text_final;
      const activeTab = detailEl.querySelector('.diff-tab[aria-selected="true"]');
      if (activeTab && activeTab.dataset.view === "raw") {
        text = item.text_raw;
      }
      try {
        await navigator.clipboard.writeText(text || "");
        const orig = btn.innerHTML;
        btn.innerHTML = "✓ 已复制";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove("copied");
        }, 1400);
      } catch (e) {
        console.error("clipboard fail", e);
      }
    });
  });
}
