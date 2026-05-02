// ---------- 工具 ----------
const fmtNum = (n) => (n ?? 0).toLocaleString();

// 累计转录时长：要 "X 时 Y 分" / "X 分 Y 秒" 这种组合格式，单位嵌在数字里
const fmtDurationCombo = (sec) => {
  if (!sec) return "0 分";
  const totalSec = Math.round(sec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
};

// 推理耗时数值（不带单位）
const fmtSecondsValue = (ms) => {
  if (!ms) return "—";
  const sec = ms / 1000;
  if (sec < 10) return sec.toFixed(2);
  return sec.toFixed(1);
};

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
};

const fmtSeconds = (ms) => {
  if (!ms) return "—";
  const sec = ms / 1000;
  if (sec < 1) return sec.toFixed(2) + " s";
  if (sec < 10) return sec.toFixed(2) + " s";
  return sec.toFixed(1) + " s";
};

const escape = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 转义字符串里的 regex 元字符
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 字符级 diff（基于 LCS）。返回合并后的 ops 数组
function diffChars(a, b) {
  a = a || ""; b = b || "";
  const m = a.length, n = b.length;
  // 长字符串保护：避免 O(m*n) 爆炸
  if (m * n > 500000) return [{ type: "delete", text: a }, { type: "insert", text: b }];

  const dp = Array.from({ length: m + 1 }, () => new Int16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", text: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", text: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  // 合并相邻同 type
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}

function renderDiff(raw, final) {
  return diffChars(raw, final).map((op) => {
    const t = escape(op.text);
    if (op.type === "equal") return t;
    if (op.type === "delete") return `<del>${t}</del>`;
    return `<ins>${t}</ins>`;
  }).join("");
}

// 转义文本后，再把 query 命中的部分包成 <mark>。query 为空 → 等价于 escape
function highlight(text, query) {
  const safe = escape(text);
  if (!query) return safe;
  // 注意：query 也要 escape 后塞入正则，避免 < > & 被当 HTML
  const re = new RegExp(escapeRegex(escape(query)), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// ---------- 通用确认弹窗 ----------
// 替代 native confirm()。返回 Promise<boolean>，true 表示用户点了确认。
// danger=true 时确认按钮变红，焦点默认放到取消按钮（避免误触）。
function customConfirm({ title = "确认操作", message = "", confirmText = "确认", cancelText = "取消", danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("confirm-dialog");
    if (!dlg || typeof dlg.showModal !== "function") {
      // 兜底：浏览器不支持 <dialog>
      resolve(window.confirm(message || title));
      return;
    }
    dlg.querySelector("#confirm-title").textContent = title;
    dlg.querySelector("#confirm-message").textContent = message;
    const ok = dlg.querySelector("#confirm-ok");
    const cancel = dlg.querySelector("#confirm-cancel");
    ok.textContent = confirmText;
    cancel.textContent = cancelText;
    ok.classList.toggle("is-danger", !!danger);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dlg.removeEventListener("click", onBackdrop);
      dlg.removeEventListener("close", onClose);
      try { dlg.close(); } catch {}
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    const onBackdrop = (e) => {
      // 点击 backdrop（事件 target 是 dialog 本身）→ 关闭
      if (e.target === dlg) finish(false);
    };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dlg.addEventListener("click", onBackdrop);
    dlg.addEventListener("close", onClose, { once: true });

    dlg.showModal();
    // 危险操作焦点放 cancel；普通操作焦点放 ok 便于回车确认
    setTimeout(() => (danger ? cancel : ok).focus(), 30);
  });
}

// ---------- 状态 ----------
const VIEWS = ["home", "history", "transcribe", "hotwords", "models"];
let currentView = null;       // 初始 null：首次 syncRoute 必触发数据加载
let currentDays = 30;
let currentClient = "all";    // "all" 或具体 client_host
let knownClients = [];

// ---------- 主题 ----------
const THEME_KEY = "asr-panel-theme";

function readTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // 图表用 CSS 变量取色，主题变了要重绘
  if (currentView === "home" && typeof loadDaily === "function") loadDaily();
}

function toggleTheme() {
  const next = readTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// 启动时立刻应用，避免闪白
applyTheme(readTheme());

// ---------- 路由 ----------
function syncRoute() {
  const hash = location.hash.replace(/^#\//, "") || "home";
  const view = VIEWS.includes(hash) ? hash : "home";
  if (view === currentView) return;
  currentView = view;

  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.dataset.view !== view;
  });
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });

  if (view === "home") loadHome();
  else if (view === "history") {
    loadHistoryClientOptions();
    loadHistory(true);
  }
  else if (view === "hotwords") loadHotwords();
  else if (view === "transcribe") resetTranscribe();
  else if (view === "models") loadModels();
}

// ---------- 首页 ----------
let dailyChart = null;

async function loadHome() {
  // 客户端列表先加载，再渲染选择器与数据
  await loadClients();
  await Promise.all([loadSummary(), loadDaily()]);
}

async function loadClients() {
  const clients = await fetchJSON("/api/stats/clients");
  if (JSON.stringify(clients) === JSON.stringify(knownClients)) return;
  knownClients = clients;
  renderClientDropdown();
}

function renderClientDropdown() {
  const menu = document.getElementById("client-menu");
  const opts = [{ key: "all", label: "全部" }, ...knownClients.map((c) => ({ key: c, label: c }))];
  menu.innerHTML = opts
    .map((o) => `<li data-client="${escape(o.key)}"${o.key === currentClient ? ' class="selected"' : ""}>${escape(o.label)}</li>`)
    .join("");
  menu.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      currentClient = li.dataset.client;
      document.getElementById("client-toggle-label").textContent = li.textContent;
      menu.querySelectorAll("li").forEach((x) => x.classList.toggle("selected", x === li));
      closeDropdown();
      loadSummary();
      loadDaily();
    });
  });
  // 同步当前选中文本
  const cur = opts.find((o) => o.key === currentClient) || opts[0];
  document.getElementById("client-toggle-label").textContent = cur.label;
}

function openDropdown() {
  document.getElementById("client-dropdown").classList.add("open");
  document.getElementById("client-menu").hidden = false;
}

function closeDropdown() {
  document.getElementById("client-dropdown").classList.remove("open");
  document.getElementById("client-menu").hidden = true;
}

function clientQuery() {
  return currentClient && currentClient !== "all" ? `&client=${encodeURIComponent(currentClient)}` : "";
}

async function loadSummary() {
  const params = new URLSearchParams();
  if (currentClient && currentClient !== "all") params.set("client", currentClient);
  if (currentDays) params.set("days", String(currentDays));
  const s = await fetchJSON(`/api/stats/summary?${params}`);
  document.getElementById("stat-chars").textContent = fmtNum(s.total_chars);
  document.getElementById("stat-keystrokes").textContent = fmtNum(s.total_keystrokes);

  // 累计时长用组合格式 "X 时 Y 分"，单位嵌在数字里，外置 unit span 留空
  document.getElementById("stat-duration").textContent = fmtDurationCombo(s.total_duration_sec);
  document.getElementById("stat-duration-unit").textContent = "";

  document.getElementById("stat-avg-dur").textContent =
    s.avg_duration_sec ? s.avg_duration_sec : "—";
  document.getElementById("stat-cpm").textContent = s.chars_per_minute || "—";
  document.getElementById("stat-inference").textContent = fmtSecondsValue(s.avg_inference_ms);

  document.getElementById("last-update").textContent =
    `更新 ${new Date().toLocaleTimeString()}`;

  // ----- 故事化 hero banner -----
  // 已使用天数 = 今天 - 数据库中最早一条记录的日期（不受时段筛选限制）
  let usedDays = "—";
  if (s.first_used_at) {
    const first = new Date(s.first_used_at);
    const ms = Date.now() - first.getTime();
    usedDays = Math.max(1, Math.floor(ms / 86400000));
  }
  document.getElementById("hero-days").textContent = usedDays;

  // 节省时间 = 手打耗时 - 实际语音耗时（100 字/分钟手打估算）
  const TYPING_WPM = 100;
  const typeMin = (s.total_chars || 0) / TYPING_WPM;
  const speakMin = (s.total_duration_sec || 0) / 60;
  const savedMin = Math.max(0, typeMin - speakMin);

  let savedLabel;
  if (savedMin >= 60) {
    const h = Math.floor(savedMin / 60);
    const m = Math.round(savedMin % 60);
    savedLabel = m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  } else if (savedMin >= 1) {
    savedLabel = `${Math.round(savedMin)} 分钟`;
  } else {
    savedLabel = "—";
  }
  document.getElementById("hero-saved").textContent = savedLabel;
}

// 本地日期 YYYY-MM-DD —— 与后端 DATE(..., 'localtime') 输出一致
function localDateKey(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

async function loadDaily() {
  const data = await fetchJSON(`/api/stats/daily?days=${currentDays}${clientQuery()}`);
  const map = new Map(data.map((d) => [d.day, d]));
  const labels = [];
  const chars = [];
  const durations = [];
  const today = new Date();
  for (let i = currentDays - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = localDateKey(dt);
    labels.push(key.slice(5));
    const row = map.get(key);
    chars.push(row ? row.chars : 0);
    durations.push(row ? +(row.duration_sec / 60).toFixed(1) : 0);
  }

  // Y 轴自适应：根据数据自身计算上下界，让小波动也清晰可见
  const niceRange = (vals) => {
    const filtered = vals.filter((v) => v > 0);
    if (filtered.length === 0) return { min: 0, max: 1 };
    const mx = Math.max(...filtered);
    const mn = Math.min(...filtered);
    const span = mx - mn;
    // 若数据基本"平"，至少给出 30% 上下浮动空间
    if (span < mx * 0.1) {
      return { min: Math.max(0, mn - mx * 0.3), max: mx * 1.15 };
    }
    return { min: Math.max(0, mn - span * 0.3), max: mx + span * 0.2 };
  };

  const charsRange = niceRange(chars);
  const durRange = niceRange(durations);

  const ctx = document.getElementById("daily-chart").getContext("2d");
  if (dailyChart) dailyChart.destroy();

  const cs = getComputedStyle(document.documentElement);
  const fg = cs.getPropertyValue("--fg-dim").trim();
  const grid = cs.getPropertyValue("--border-soft").trim();
  const data1 = cs.getPropertyValue("--data-1").trim();
  const data2 = cs.getPropertyValue("--data-2").trim();

  dailyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "字数",
          data: chars,
          borderColor: data1,
          backgroundColor: data1 + "22",
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "时长(分)",
          data: durations,
          borderColor: data2,
          backgroundColor: "transparent",
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          borderDash: [4, 3],
          fill: false,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0c0c0d",
          borderColor: "#1f1f23",
          borderWidth: 1,
          titleColor: "#fafafa",
          bodyColor: "#a1a1aa",
          padding: 10,
          cornerRadius: 6,
          displayColors: true,
        },
      },
      scales: {
        x: {
          ticks: { color: fg, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { display: false },
          border: { color: grid },
        },
        y: {
          position: "left",
          min: charsRange.min,
          max: charsRange.max,
          ticks: { color: fg, maxTicksLimit: 5 },
          grid: { color: grid, drawTicks: false },
          border: { display: false },
          title: { display: true, text: "字数", color: fg, font: { size: 11 } },
        },
        y1: {
          position: "right",
          min: durRange.min,
          max: durRange.max,
          ticks: { color: fg, maxTicksLimit: 5 },
          grid: { display: false },
          border: { display: false },
          title: { display: true, text: "时长 (分)", color: fg, font: { size: 11 } },
        },
      },
    },
  });
}

// ---------- 历史记录 ----------
const PAGE_SIZE = 50;
let historyOffset = 0;
let historyHasMore = true;
let historyQuery = "";
let historyClient = "all";   // "all" 或具体 client_host
let historySince = "";       // YYYY-MM-DD
let historyUntil = "";       // YYYY-MM-DD
let historyPostProc = "all"; // "all" / "1" / "0"

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

  // 「清除全部」按钮可见性
  document.getElementById("filter-reset").hidden = !hasFilter;
}

// ----- 通用自定义 dropdown 助手 -----
// dd: { rootId, labelId, items: [{value, label}], onChange }
function setupDropdown({ rootId, labelId, items, initialValue, onChange }) {
  const root = document.getElementById(rootId);
  const toggle = root.querySelector(".dropdown-toggle");
  const menu = root.querySelector(".dropdown-menu");
  const labelEl = document.getElementById(labelId);

  const render = (selected) => {
    menu.innerHTML = items
      .map(
        (o) =>
          `<li data-value="${escape(o.value)}"${
            o.value === selected ? ' class="selected"' : ""
          }>${escape(o.label)}</li>`
      )
      .join("");
    const cur = items.find((o) => o.value === selected) || items[0];
    if (cur) labelEl.textContent = cur.label;

    menu.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = li.dataset.value;
        render(v);
        close();
        onChange(v);
      });
    });
  };

  const open = () => {
    root.classList.add("open");
    menu.hidden = false;
  };
  const close = () => {
    root.classList.remove("open");
    menu.hidden = true;
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    root.classList.contains("open") ? close() : open();
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) close();
  });

  render(initialValue);
  return { setItems: (newItems, sel) => { items = newItems; render(sel); } };
}

let historyClientDD = null;
let historyPostDD = null;

async function loadHistoryClientOptions() {
  const list = await fetchJSON("/api/stats/clients");
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

  // 日期范围（自定义 calendar popover）
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

  // 一键重置
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

// ---------- 自定义日历 popover ----------
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIso(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function setupCalendarPopover({ onChange }) {
  let popover = null;
  let activeTrigger = null;
  let viewYear = 0;
  let viewMonth = 0;

  const close = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
    if (activeTrigger) activeTrigger.classList.remove("is-open");
    activeTrigger = null;
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
  };

  const onDocClick = (e) => {
    if (popover && !popover.contains(e.target) && !e.target.closest(".date-trigger")) close();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  const render = () => {
    const first = new Date(viewYear, viewMonth, 1);
    // 周一为一周起点：(getDay()+6)%7
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDays = new Date(viewYear, viewMonth, 0).getDate();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayIso = fmtIso(today);
    const hidden = document.getElementById(activeTrigger.dataset.target);
    const selectedIso = hidden.value;

    const cells = [];
    // 上月填充
    for (let i = offset - 1; i >= 0; i--) {
      const d = prevDays - i;
      const iso = fmtIso(new Date(viewYear, viewMonth - 1, d));
      cells.push({ d, iso, otherMonth: true });
    }
    // 当月
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = fmtIso(new Date(viewYear, viewMonth, d));
      cells.push({ d, iso, otherMonth: false });
    }
    // 下月填充到 42 格
    let nd = 1;
    while (cells.length < 42) {
      const iso = fmtIso(new Date(viewYear, viewMonth + 1, nd));
      cells.push({ d: nd++, iso, otherMonth: true });
    }

    popover.innerHTML = `
      <div class="cal-head">
        <button class="cal-nav cal-prev" type="button" aria-label="上一月">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="cal-title">${viewYear} 年 ${viewMonth + 1} 月</span>
        <button class="cal-nav cal-next" type="button" aria-label="下一月">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="cal-weekdays">
        ${WEEKDAYS.map((w) => `<span class="cal-weekday">${w}</span>`).join("")}
      </div>
      <div class="cal-grid">
        ${cells.map((c) => {
          const cls = ["cal-day"];
          if (c.otherMonth) cls.push("is-other-month");
          if (c.iso === todayIso) cls.push("is-today");
          if (c.iso === selectedIso) cls.push("is-selected");
          return `<button type="button" class="${cls.join(" ")}" data-iso="${c.iso}">${c.d}</button>`;
        }).join("")}
      </div>
      <div class="cal-foot">
        <button class="cal-action cal-today-btn" type="button" data-action="today">今天</button>
        <button class="cal-action" type="button" data-action="clear">清空</button>
      </div>
    `;

    popover.querySelector(".cal-prev").addEventListener("click", (e) => {
      e.stopPropagation();
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      render();
    });
    popover.querySelector(".cal-next").addEventListener("click", (e) => {
      e.stopPropagation();
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    });

    popover.querySelectorAll(".cal-day").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        hidden.value = btn.dataset.iso;
        onChange();
        close();
      });
    });

    popover.querySelectorAll(".cal-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.action === "today") hidden.value = todayIso;
        else hidden.value = "";
        onChange();
        close();
      });
    });
  };

  const open = (trigger) => {
    if (activeTrigger === trigger) { close(); return; }
    close();
    activeTrigger = trigger;
    trigger.classList.add("is-open");

    const hidden = document.getElementById(trigger.dataset.target);
    const initial = parseIso(hidden.value) || new Date();
    viewYear = initial.getFullYear();
    viewMonth = initial.getMonth();

    popover = document.createElement("div");
    popover.className = "calendar-popover";
    // 锚到 .date-range 容器，确保两个日期 trigger 的 popover 位置一致
    const anchor = trigger.closest(".date-range");
    anchor.appendChild(popover);
    // 让 popover 对齐当前 trigger
    const triggerRect = trigger.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${triggerRect.left - anchorRect.left}px`;

    render();
    setTimeout(() => {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  };

  document.querySelectorAll(".date-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      open(trigger);
    });
  });
}

function appendHistoryItems(items) {
  const ul = document.getElementById("recent-list");
  // 搜索时切到 in-search 模式：放开 -webkit-line-clamp 显示完整文本
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
    // 直接读 db 字段，避免对每条都跑 LCS 比对
    const isModified = item.post_processed === 1;

    // 预览文本：经过后处理的（raw != final）直接渲染 diff，让用户折叠状态就能看出
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
      // 点 audio / copy / 标签页 时不要折叠
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
        // raw 和 final 一致 → 一段普通文本
        html += `
          <div class="detail-section">
            <div class="detail-section-head">
              <span class="detail-label">转录文本</span>
              <button class="btn-copy" type="button">⧉ 复制</button>
            </div>
            <div class="detail-text">${highlight(item.text_final, historyQuery)}</div>
          </div>`;
      } else {
        // 后处理改写过 → 三态可切换（差异对比 / 原始 / 后处理）
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

  // Client / Audio Duration 已在卡片头部呈现，避免重复
  const metaRows = [
    ["⏱", "推理耗时", fmtSeconds(item.inference_ms)],
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
          </div>`
          )
          .join("")}
      </div>
    </div>`;

  detailEl.innerHTML = html;
  detailEl.dataset.loaded = "1";

  // 差异视图三态切换
  detailEl.querySelectorAll(".diff-tab").forEach((tab) => {
    tab.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const view = tab.dataset.view;
      detailEl.querySelectorAll(".diff-tab").forEach((t) =>
        t.setAttribute("aria-selected", t === tab ? "true" : "false")
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
      // 跟随当前显示内容：sameRaw → 复制 final；
      // 多 tab 时根据当前选中的 tab（diff 视图视为 final，因为 diff 是 final 的可视化）
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

// ---------- 启动 ----------
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("#period-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#period-switch button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.dataset.days, 10);
      // 时段切换：summary 卡片 + 折线图都按新时间窗刷新
      loadSummary();
      loadDaily();
    });
  });

  document.getElementById("load-more-btn").addEventListener("click", () => loadHistory(false));

  // 历史搜索：300ms 防抖
  const searchInput = document.getElementById("history-search");
  const searchClear = document.getElementById("history-search-clear");
  let searchTimer = null;
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

  // 历史页筛选栏（日期、客户端、后处理、重置）
  setupHistoryFilters();
  setupHotwords();
  setupTranscribe();
  setupModelsPage();
  setupModelSearch();

  // 主题切换
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

  // 客户端下拉
  document.getElementById("client-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = document.getElementById("client-dropdown").classList.contains("open");
    isOpen ? closeDropdown() : openDropdown();
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("client-dropdown").contains(e.target)) closeDropdown();
  });

  // 音频互斥播放：开始播一个时，自动暂停其他正在播放的 audio。
  // 用 capture 阶段监听全局 play 事件，无需每个 audio 单独绑定 —— 简洁可靠。
  document.addEventListener("play", (e) => {
    if (e.target.tagName !== "AUDIO") return;
    document.querySelectorAll("audio").forEach((other) => {
      if (other !== e.target && !other.paused) other.pause();
    });
  }, true);

  window.addEventListener("hashchange", syncRoute);
  syncRoute();

  // 热词管理：从其他页面切到 hotwords 时，syncRoute 会触发 loadHotwords；
  // hotwords 页内增删改本身不触发 syncRoute（不变 hash），由 setupHotwords 管理交互

  // 30s 轮询首页 summary（仅在 home view，避开历史记录页）
  setInterval(() => {
    if (currentView === "home") {
      loadClients();
      loadSummary();
    }
  }, 30000);
});

// ---------- 热词管理 ----------
// 数据模型：行 = { target, variants[], phonetic, pinyin[] }，互转 toml。
let hotwordsRows = [];
let hotwordsMode = "table";   // "table" | "raw"
let hotwordsRawText = "";     // raw 模式下的原文

async function loadHotwords() {
  const data = await fetchJSON("/api/hotwords");
  hotwordsRawText = data.text || "";
  hotwordsRows = parsedToRows(data.parsed);
  if (data.parsed === null) {
    // 解析失败：自动切到原文模式让用户修
    hotwordsMode = "raw";
    showHotwordsError(`hotwords.toml 当前解析失败：${data.error || "未知错误"}。已切到原文模式，请直接修复。`);
  } else {
    hideHotwordsError();
  }
  syncHotwordsModeUI();
  renderHotwordsTable();
  document.getElementById("hotwords-raw").value = hotwordsRawText;
}

function parsedToRows(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  return Object.entries(parsed).map(([target, val]) => {
    if (Array.isArray(val)) {
      return { target, variants: val.slice(), phonetic: false, pinyin: [] };
    }
    if (val && typeof val === "object") {
      return {
        target,
        variants: Array.isArray(val.variants) ? val.variants.slice() : [],
        phonetic: Boolean(val.phonetic),
        pinyin: Array.isArray(val.pinyin) ? val.pinyin.slice() : [],
      };
    }
    return { target, variants: [], phonetic: false, pinyin: [] };
  });
}

// 行模型 → toml 文本。变体不带 phonetic/pinyin → 简写形式 `target = ["a", "b"]`，
// 带 phonetic 或 pinyin → 块形式 `[hotwords.target]\nvariants = [...]\nphonetic = true\npinyin = [...]`
function rowsToToml(rows) {
  const simple = [];
  const blocks = [];
  for (const row of rows) {
    if (!row.target) continue;
    const target = row.target;
    const variants = (row.variants || []).filter((v) => v.length > 0);
    if (row.phonetic || (row.pinyin && row.pinyin.length > 0)) {
      const lines = [`[hotwords.${tomlKey(target)}]`];
      lines.push(`variants = ${tomlStringList(variants)}`);
      lines.push(`phonetic = ${row.phonetic ? "true" : "false"}`);
      if (row.pinyin && row.pinyin.length > 0) {
        lines.push(`pinyin = ${tomlStringList(row.pinyin)}`);
      }
      blocks.push(lines.join("\n"));
    } else {
      simple.push(`${tomlKey(target)} = ${tomlStringList(variants)}`);
    }
  }
  let out = "[hotwords]\n";
  if (simple.length) out += simple.join("\n") + "\n";
  if (blocks.length) out += "\n" + blocks.join("\n\n") + "\n";
  return out;
}

// toml key 引号策略：含非 ASCII / 特殊字符则加引号，否则裸键
function tomlKey(s) {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s);
}

function tomlStringList(items) {
  return "[" + items.map((s) => JSON.stringify(s)).join(", ") + "]";
}

function renderHotwordsTable() {
  const tbody = document.getElementById("hotwords-tbody");
  if (!tbody) return;
  if (hotwordsRows.length === 0) {
    tbody.innerHTML = `<tr class="hw-empty"><td colspan="5">暂无热词，点击右上角「+ 新增」开始。</td></tr>`;
    return;
  }
  tbody.innerHTML = hotwordsRows.map((row, i) => `
    <tr data-idx="${i}">
      <td><input class="hw-input hw-target" type="text" value="${escape(row.target)}" placeholder="目标词"></td>
      <td><input class="hw-input hw-variants" type="text" value="${escape((row.variants || []).join(", "))}" placeholder="变体 1, 变体 2"></td>
      <td class="hw-cell-center">
        <label class="hw-switch">
          <input type="checkbox" class="hw-phonetic"${row.phonetic ? " checked" : ""}>
          <span class="hw-switch-slider"></span>
        </label>
      </td>
      <td><input class="hw-input hw-pinyin" type="text" value="${escape((row.pinyin || []).join(", "))}" placeholder="zhu, bao, duo"${row.phonetic ? "" : " disabled"}></td>
      <td class="hw-cell-center">
        <button class="hw-row-delete" type="button" aria-label="删除" data-action="delete">×</button>
      </td>
    </tr>
  `).join("");
}

function readRowsFromTable() {
  const tbody = document.getElementById("hotwords-tbody");
  if (!tbody) return [];
  const result = [];
  tbody.querySelectorAll("tr[data-idx]").forEach((tr) => {
    const target = tr.querySelector(".hw-target").value.trim();
    const variantsText = tr.querySelector(".hw-variants").value;
    const pinyinText = tr.querySelector(".hw-pinyin").value;
    const phonetic = tr.querySelector(".hw-phonetic").checked;
    result.push({
      target,
      variants: variantsText.split(",").map((s) => s.trim()).filter(Boolean),
      phonetic,
      pinyin: pinyinText.split(",").map((s) => s.trim()).filter(Boolean),
    });
  });
  return result;
}

function syncHotwordsModeUI() {
  document.querySelectorAll("#hotwords-mode button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === hotwordsMode);
  });
  document.getElementById("hotwords-table-view").hidden = hotwordsMode !== "table";
  document.getElementById("hotwords-raw-view").hidden = hotwordsMode !== "raw";
}

function showHotwordsError(msg) {
  const el = document.getElementById("hotwords-error");
  el.textContent = msg;
  el.hidden = false;
}

function hideHotwordsError() {
  const el = document.getElementById("hotwords-error");
  el.hidden = true;
  el.textContent = "";
}

function setupHotwords() {
  // 模式切换
  document.querySelectorAll("#hotwords-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.mode;
      if (next === hotwordsMode) return;
      // 切到 raw 时，把当前表格状态序列化到原文；切回 table 时，把原文解析回行
      if (hotwordsMode === "table" && next === "raw") {
        hotwordsRows = readRowsFromTable();
        hotwordsRawText = rowsToToml(hotwordsRows);
        document.getElementById("hotwords-raw").value = hotwordsRawText;
      } else if (hotwordsMode === "raw" && next === "table") {
        hotwordsRawText = document.getElementById("hotwords-raw").value;
        // 用后端校验：但本地不解析 toml，简单做：保存时再校验。这里直接保留原文，渲染时尝试 best-effort parse
        // 用一个简单的 fallback：发到后端 GET 不太合适，干脆什么都不做，让用户保存后重新加载
        // 更简洁：只用本地解析失败的提示，不重新加载行
      }
      hotwordsMode = next;
      syncHotwordsModeUI();
    });
  });

  // 新增一行
  document.getElementById("hotwords-add-btn").addEventListener("click", () => {
    if (hotwordsMode !== "table") return;
    hotwordsRows = readRowsFromTable();
    hotwordsRows.push({ target: "", variants: [], phonetic: false, pinyin: [] });
    renderHotwordsTable();
    // 焦点定位到新行的 target
    const last = document.querySelector("#hotwords-tbody tr:last-child .hw-target");
    if (last) last.focus();
  });

  // 表格事件委托：删除 + 切换 phonetic 时联动启用拼音输入
  document.getElementById("hotwords-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='delete']");
    if (!btn) return;
    const tr = btn.closest("tr[data-idx]");
    if (!tr) return;
    hotwordsRows = readRowsFromTable();
    hotwordsRows.splice(Number(tr.dataset.idx), 1);
    renderHotwordsTable();
  });

  document.getElementById("hotwords-tbody").addEventListener("change", (e) => {
    if (!e.target.classList.contains("hw-phonetic")) return;
    const tr = e.target.closest("tr[data-idx]");
    if (!tr) return;
    const pinyinInput = tr.querySelector(".hw-pinyin");
    pinyinInput.disabled = !e.target.checked;
  });

  // 保存
  document.getElementById("hotwords-save-btn").addEventListener("click", saveHotwords);
}

async function saveHotwords() {
  let text;
  if (hotwordsMode === "table") {
    hotwordsRows = readRowsFromTable();
    // 简单的客户端预校验：不允许空 target
    const empty = hotwordsRows.find((r) => !r.target && (r.variants.length || r.phonetic));
    if (empty) {
      showHotwordsError("有规则缺少目标词，请补全或删除该行。");
      return;
    }
    // 允许全空：等于清空热词
    text = rowsToToml(hotwordsRows.filter((r) => r.target));
  } else {
    text = document.getElementById("hotwords-raw").value;
  }

  const btn = document.getElementById("hotwords-save-btn");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const r = await fetch("/api/hotwords", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showHotwordsError(`保存失败：${body.error || r.status}`);
      return;
    }
    hideHotwordsError();
    flashSaveSuccess(`已保存（${body.count} 条规则）`);
    // 重新拉一次以同步 server 端原文（包括我们自己的格式化）
    await loadHotwords();
  } catch (err) {
    showHotwordsError(`保存失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

function flashSaveSuccess(msg) {
  const el = document.getElementById("hotwords-error");
  el.textContent = msg;
  el.hidden = false;
  el.classList.add("ok");
  setTimeout(() => {
    el.classList.remove("ok");
    el.hidden = true;
    el.textContent = "";
  }, 2200);
}

// ---------- 转录页 ----------
// 三个输入路径都最终走 POST /v1/audio/transcriptions（multipart）。
// 麦克风录音用 Web Audio API 收 PCM，前端打包成 WAV blob 上传，
// 后端无需新依赖（soundfile/librosa 直接解 WAV）。

const transState = {
  recording: false,
  audioCtx: null,
  source: null,
  processor: null,
  stream: null,
  chunks: [],
  sampleRate: 0,
  recStartMs: 0,
  timerHandle: null,
  meterHandle: null,
  blobUrl: null,
};

function setupTranscribe() {
  const dz = document.getElementById("trans-dropzone");
  const fileInput = document.getElementById("trans-file");
  if (!dz || !fileInput) return;

  // 点击 dropzone 触发文件选择
  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) submitAudio(f);
    fileInput.value = "";
  });

  // 拖拽
  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) submitAudio(f);
  });

  // 录音
  document.getElementById("trans-rec-btn").addEventListener("click", toggleRecording);

  // 复制 / 重置
  document.getElementById("trans-copy-btn").addEventListener("click", () => {
    const text = document.getElementById("trans-result-text").innerText;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("trans-copy-btn");
      const orig = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = orig; }, 1400);
    });
  });
  document.getElementById("trans-reset-btn").addEventListener("click", resetTranscribe);
}

function resetTranscribe() {
  document.getElementById("trans-status").hidden = true;
  document.getElementById("trans-result").hidden = true;
  document.getElementById("trans-rec-time").textContent = "00:00";
  setMeter(0);
  if (transState.recording) stopRecordingDiscard();
  if (transState.blobUrl) {
    URL.revokeObjectURL(transState.blobUrl);
    transState.blobUrl = null;
  }
}

function showTransStatus(html, kind = "info") {
  const el = document.getElementById("trans-status");
  el.className = `trans-status trans-status-${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}

function setRecordingUI(on) {
  const btn = document.getElementById("trans-rec-btn");
  const label = document.getElementById("trans-rec-label");
  btn.classList.toggle("recording", on);
  label.textContent = on ? "停止录音" : "开始录音";
  btn.setAttribute("aria-label", on ? "停止录音" : "开始录音");
}

function setMeter(level) {
  const bar = document.getElementById("trans-rec-meter-bar");
  if (!bar) return;
  bar.style.width = `${Math.min(100, Math.round(level * 100))}%`;
}

async function toggleRecording() {
  if (transState.recording) {
    const blob = await stopRecording();
    if (blob) {
      // 录音文件本地预览 URL
      transState.blobUrl = URL.createObjectURL(blob);
      const file = new File([blob], `recording-${Date.now()}.wav`, { type: "audio/wav" });
      submitAudio(file, transState.blobUrl);
    }
    return;
  }
  try {
    await startRecording();
  } catch (err) {
    showTransStatus(`无法访问麦克风：${escape(err.message || err)}`, "error");
  }
}

async function startRecording() {
  resetTranscribe();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessor 已废弃但浏览器仍兼容；用最小代价收 PCM。
  // 待 AudioWorklet 普及度更高再迁移。
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // ScriptProcessor 必须连到 destination 才会 fire onaudioprocess（即使我们不想出声）
  processor.connect(audioCtx.destination);

  // 实时电平：用 AnalyserNode（与 processor 并联）
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tickMeter = () => {
    if (!transState.recording) return;
    analyser.getByteTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > max) max = v;
    }
    setMeter(max);
    transState.meterHandle = requestAnimationFrame(tickMeter);
  };

  Object.assign(transState, {
    recording: true, audioCtx, source, processor, stream, chunks,
    sampleRate: audioCtx.sampleRate, recStartMs: Date.now(),
  });
  setRecordingUI(true);
  transState.meterHandle = requestAnimationFrame(tickMeter);
  transState.timerHandle = setInterval(updateRecTime, 250);
}

function updateRecTime() {
  const elapsed = Math.floor((Date.now() - transState.recStartMs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  document.getElementById("trans-rec-time").textContent = `${mm}:${ss}`;
}

async function stopRecording() {
  if (!transState.recording) return null;
  // 拆 audio graph
  try { transState.processor.disconnect(); } catch {}
  try { transState.source.disconnect(); } catch {}
  try { transState.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { await transState.audioCtx.close(); } catch {}
  if (transState.timerHandle) clearInterval(transState.timerHandle);
  if (transState.meterHandle) cancelAnimationFrame(transState.meterHandle);
  setMeter(0);

  const sampleRate = transState.sampleRate;
  const chunks = transState.chunks;
  transState.recording = false;
  transState.chunks = [];
  setRecordingUI(false);

  if (chunks.length === 0) return null;
  return new Blob([encodeWav(chunks, sampleRate)], { type: "audio/wav" });
}

function stopRecordingDiscard() {
  // 仅做清理，不返回 blob
  try { transState.processor && transState.processor.disconnect(); } catch {}
  try { transState.source && transState.source.disconnect(); } catch {}
  try { transState.stream && transState.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { transState.audioCtx && transState.audioCtx.close(); } catch {}
  if (transState.timerHandle) clearInterval(transState.timerHandle);
  if (transState.meterHandle) cancelAnimationFrame(transState.meterHandle);
  transState.recording = false;
  transState.chunks = [];
  setRecordingUI(false);
  setMeter(0);
}

// Float32 chunks → WAV (PCM 16-bit mono) ArrayBuffer
function encodeWav(chunks, sampleRate) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const merged = new Float32Array(length);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, merged[i]));
    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
  }

  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);   // fmt chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);    // block align
  view.setUint16(34, 16, true);   // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

async function submitAudio(file, audioUrl = null) {
  document.getElementById("trans-result").hidden = true;
  showTransStatus(`<span class="trans-spinner" aria-hidden="true"></span>正在转录 ${escape(file.name || "audio")}（${(file.size / 1024).toFixed(1)} KB）…`, "info");

  // 本地预览：上传的文件直接生成 blob URL（录音的话已经传进来了）
  if (!audioUrl && file instanceof Blob) {
    audioUrl = URL.createObjectURL(file);
    transState.blobUrl = audioUrl;
  }

  const t0 = Date.now();
  const fd = new FormData();
  fd.append("file", file, file.name || "upload.wav");
  try {
    const r = await fetch("/v1/audio/transcriptions", { method: "POST", body: fd });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const body = await r.json(); if (body.error) msg = body.error; } catch {}
      showTransStatus(`转录失败：${escape(msg)}`, "error");
      return;
    }
    const body = await r.json();
    document.getElementById("trans-status").hidden = true;
    renderTranscribeResult({
      text: body.text || "",
      audioUrl,
      elapsed,
      filename: file.name,
      size: file.size,
    });
  } catch (err) {
    showTransStatus(`请求失败：${escape(err.message || err)}`, "error");
  }
}

function renderTranscribeResult({ text, audioUrl, elapsed, filename, size }) {
  const result = document.getElementById("trans-result");
  document.getElementById("trans-result-meta").textContent =
    `${filename || "audio"} · ${(size / 1024).toFixed(1)} KB · 耗时 ${elapsed}s`;
  document.getElementById("trans-result-text").textContent = text || "(空)";
  const audio = document.getElementById("trans-result-audio");
  if (audioUrl) {
    audio.src = audioUrl;
    audio.hidden = false;
  } else {
    audio.removeAttribute("src");
    audio.hidden = true;
  }
  // raw 输出当前接口未返回，预留 details 关闭
  document.getElementById("trans-result-raw-wrap").hidden = true;
  result.hidden = false;
}

// ---------- 模型管理 ----------

async function loadModels() {
  const el = document.getElementById("models-list");
  el.innerHTML = `<li class="models-empty">加载中…</li>`;
  hideModelsError();
  let activeDownloads = [];
  try {
    const [data, dl] = await Promise.all([
      fetchJSON("/api/models"),
      fetchJSON("/api/models/downloads").catch(() => ({ items: [] })),
    ]);
    activeDownloads = (dl.items || []).filter((t) => t.state === "queued" || t.state === "running");
    const downloadingNames = new Set(activeDownloads.map((t) => t.target_name));
    document.getElementById("models-meta").textContent =
      `${data.items.length} 个已下载 · ${escape(data.models_dir)}`;
    renderModels(data.items, data.active, downloadingNames);
    renderRecommended(data.recommended || [], downloadingNames);
  } catch (err) {
    showModelsError(`加载失败：${escape(err.message || err)}`);
    el.innerHTML = "";
    return;
  }
  // 服务进程仍在跑而前端刷新过 → 自动恢复 polling
  if (activeDownloads.length > 0 && !modelDownloadPoller) {
    const t = activeDownloads[0];
    modelDownloadActiveTaskId = t.task_id;
    startModelDownloadPolling(t.task_id);
  }
}

function renderModels(items, active, downloadingNames = new Set()) {
  const el = document.getElementById("models-list");
  if (!items.length) {
    el.innerHTML = `<li class="models-empty">尚未下载任何模型，从下方推荐区选一个开始。</li>`;
    return;
  }
  el.innerHTML = items.map((m) => {
    const downloading = downloadingNames.has(m.name);
    const downloadingBadge = downloading
      ? '<span class="model-badge model-badge-downloading">下载中</span>'
      : "";
    const showActions = !downloading;
    return `
    <li class="model-card${m.is_current ? " is-current" : ""}${m.valid ? "" : " is-invalid"}${downloading ? " is-downloading" : ""}">
      <div class="model-card-head">
        <div class="model-card-title">
          <span class="model-name">${escape(m.name)}</span>
          ${m.is_current ? '<span class="model-badge model-badge-current">当前激活</span>' : ""}
          ${downloadingBadge}
          ${m.valid || downloading ? "" : '<span class="model-badge model-badge-warn">无 config 文件</span>'}
        </div>
        <div class="model-card-right">
          <span class="model-size">${escape(m.size_human)}</span>
          <div class="model-actions">
            ${showActions && !m.is_current && m.valid ? `<button class="model-act-btn model-act-activate" data-action="activate" data-name="${escape(m.name)}">使用此模型</button>` : ""}
            ${showActions && !m.is_current ? `<button class="model-act-btn model-act-delete" data-action="delete" data-name="${escape(m.name)}">删除</button>` : ""}
          </div>
        </div>
      </div>
      <div class="model-card-path" title="${escape(m.path)}">${escape(m.path)}</div>
    </li>
  `;
  }).join("");
  el.onclick = handleModelAction;
}

function renderRecommended(families, downloadingNames = new Set()) {
  const el = document.getElementById("models-recommended");
  if (!el) return;
  if (!families.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = families.map((f) => renderFamilyCard(f, downloadingNames)).join("");
  el.onclick = handleModelAction;
}

function renderFamilyCard(f, downloadingNames = new Set()) {
  const downloadedCount = f.variants.filter((v) => v.downloaded).length;
  const statusBadge = f.any_current
    ? '<span class="model-badge model-badge-current">当前激活</span>'
    : (downloadedCount > 0
        ? `<span class="model-badge model-badge-downloaded">${downloadedCount}/${f.variant_count} 已下载</span>`
        : `<span class="model-badge model-badge-soft">${f.variant_count} 个版本</span>`);

  // 展开默认状态：family 内已下载或当前激活 → 展开；否则收起
  const open = f.any_downloaded || f.any_current;
  return `
    <li class="model-card model-family-card${f.any_current ? " is-current" : ""}${f.any_downloaded ? " is-downloaded" : ""}">
      <details${open ? " open" : ""}>
        <summary class="family-summary">
          <div class="family-summary-main">
            <span class="model-name">${escape(f.name)}</span>
            ${statusBadge}
            ${f.languages.length ? `<span class="model-langs">${f.languages.map(escape).join(" · ")}</span>` : ""}
          </div>
          <span class="family-caret" aria-hidden="true">▾</span>
        </summary>
        <div class="family-summary-text">${escape(f.summary)}</div>
        <ul class="variants-list">
          ${f.variants.map((v) => renderVariantRow(v, downloadingNames)).join("")}
        </ul>
      </details>
    </li>
  `;
}

function renderVariantRow(v, downloadingNames = new Set()) {
  const downloading = downloadingNames.has(v.target_name);
  const stateBadge = downloading
    ? '<span class="model-badge model-badge-downloading">下载中</span>'
    : (v.is_current
        ? '<span class="model-badge model-badge-current">当前激活</span>'
        : (v.downloaded ? '<span class="model-badge model-badge-downloaded">已下载</span>' : ""));
  let action;
  if (downloading) {
    action = "";
  } else if (v.downloaded) {
    action = v.is_current
      ? ""
      : `<button class="model-act-btn model-act-activate" data-action="activate" data-name="${escape(v.target_name)}">使用此模型</button>`;
  } else {
    action = `<button class="model-act-btn model-act-download" data-action="download" data-id="${escape(v.model_id)}">下载</button>`;
  }

  const paramsBadge = v.params_b != null
    ? `<span class="model-badge model-badge-params">${formatParams(v.params_b)}</span>`
    : "";
  const precisionBadge = v.precision
    ? `<span class="model-badge model-badge-precision">${escape(v.precision)}</span>`
    : "";

  const vram = estimateVram(v.params_b, v.precision);
  const vramHint = vram
    ? `<span class="variant-vram" title="按 ${escape(v.precision || "FP16")} 估算 · 公式：参数(B) × bytes × 1.2 overhead">显存约 ${vram}</span>`
    : "";

  return `
    <li class="variant-row${v.is_current ? " is-current" : ""}">
      <div class="variant-main">
        <span class="variant-label" title="${escape(v.model_id)}">${escape(v.label)}</span>
        ${paramsBadge}
        ${precisionBadge}
        <span class="model-badge model-badge-backend">${escape(v.backend)}</span>
        ${stateBadge}
      </div>
      <div class="variant-aside">
        <div class="variant-sizes">
          <span class="variant-storage">存储约 ${escape(v.size_human)}</span>
          ${vramHint}
        </div>
        ${action}
      </div>
      ${v.summary ? `<div class="variant-summary-line">${escape(v.summary)}</div>` : ""}
    </li>
  `;
}

function formatParams(b) {
  if (b == null) return "";
  if (b >= 1) return `${b}B`;
  // 小于 1B 时以 M 为单位更直观
  return `${Math.round(b * 1000)}M`;
}

// 显存估算：bytes_per_param 按精度查表 × 1.2 overhead（KV cache + activation）
// 系数参考 vllm / huggingface 文档与社区共识
const _BYTES_PER_PARAM = {
  "FP32": 4, "BF32": 4,
  "FP16": 2, "BF16": 2, "F16": 2,
  "FP8": 1, "F8": 1,
  "INT8": 1, "W8A16": 1, "Q8": 1.06,
  "INT4": 0.5, "W4A16": 0.5, "Q4": 0.55, "GGUF Q4": 0.55, "GGUF-Q4": 0.55,
  "INT2": 0.3,
};

function estimateVram(paramsB, precision) {
  if (!paramsB) return null;
  const bpp = _BYTES_PER_PARAM[(precision || "FP16").toUpperCase()] ?? 2;
  const gb = paramsB * bpp * 1.2;
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${gb.toFixed(1)} GB`;
}

async function handleModelAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const name = btn.dataset.name;
  if (action === "delete") return deleteModel(name, btn);
  if (action === "activate") return activateModel(name, btn);
  if (action === "download") return triggerModelDownload(btn.dataset.id, btn);
}

async function activateModel(name, btn) {
  const ok = await customConfirm({
    title: "切换激活模型",
    message: `将激活模型切换为「${name}」？切换期间会释放当前模型并加载新模型，可能需要十几秒，期间转录请求会等待。`,
    confirmText: "切换",
  });
  if (!ok) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "切换中…";
  // 同步禁用页面上其他动作按钮
  document.querySelectorAll(".model-act-btn").forEach((b) => { b.disabled = true; });
  showModelsError(`正在切换到 ${name}…`);
  try {
    const r = await fetch("/api/models/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showModelsError(`切换失败：${body.error || r.status}`);
      btn.disabled = false;
      btn.textContent = orig;
      document.querySelectorAll(".model-act-btn").forEach((b) => { b.disabled = false; });
      return;
    }
    hideModelsError();
    await loadModels();
  } catch (err) {
    showModelsError(`请求失败：${err.message || err}`);
    btn.disabled = false;
    btn.textContent = orig;
    document.querySelectorAll(".model-act-btn").forEach((b) => { b.disabled = false; });
  }
}

async function deleteModel(name, btn) {
  const ok = await customConfirm({
    title: "删除模型",
    message: `确认删除模型「${name}」？此操作会删除整个目录，无法撤销。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "删除中…";
  try {
    const r = await fetch(`/api/models/${encodeURIComponent(name)}`, { method: "DELETE" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showModelsError(`删除失败：${body.error || r.status}`);
      btn.disabled = false;
      btn.textContent = "删除";
      return;
    }
    hideModelsError();
    await loadModels();
  } catch (err) {
    showModelsError(`请求失败：${err.message || err}`);
    btn.disabled = false;
    btn.textContent = "删除";
  }
}

function showModelsError(msg) {
  const el = document.getElementById("models-error");
  el.textContent = msg;
  el.hidden = false;
}

function hideModelsError() {
  const el = document.getElementById("models-error");
  el.hidden = true;
  el.textContent = "";
}

// ---------- 模型下载 ----------
let modelDownloadPoller = null;
let modelDownloadActiveTaskId = null;

function setupModelsPage() {
  const btn = document.getElementById("model-download-btn");
  const input = document.getElementById("model-download-id");
  if (!btn || !input) return;

  btn.addEventListener("click", () => triggerModelDownload(input.value.trim(), btn));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerModelDownload(input.value.trim(), btn);
  });
}

async function triggerModelDownload(modelId, sourceBtn = null) {
  if (!modelId) {
    showModelsError("请填写 model_id（如 iic/SenseVoiceSmall）");
    return;
  }
  if (!modelId.includes("/")) {
    showModelsError("model_id 必须形如 org/name");
    return;
  }
  hideModelsError();
  const btn = sourceBtn || document.getElementById("model-download-btn");
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "提交中…";
  try {
    const r = await fetch("/api/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showModelsError(`下载失败：${body.error || r.status}`);
      btn.disabled = false;
      btn.textContent = origLabel;
      return;
    }
    modelDownloadActiveTaskId = body.task_id;
    const customInput = document.getElementById("model-download-id");
    if (customInput) customInput.value = "";
    startModelDownloadPolling(body.task_id);
  } catch (err) {
    showModelsError(`请求失败：${err.message || err}`);
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function startModelDownloadPolling(taskId) {
  stopModelDownloadPolling();
  document.getElementById("model-task-card").hidden = false;
  modelDownloadPoller = setInterval(async () => {
    try {
      const data = await fetchJSON(`/api/models/download/${taskId}`);
      renderDownloadTask(data);
      if (data.state === "done" || data.state === "error") {
        stopModelDownloadPolling();
        // 完成后刷新模型列表
        loadModels();
      }
    } catch (err) {
      stopModelDownloadPolling();
      showModelsError(`查询任务失败：${err.message || err}`);
    }
  }, 1000);
}

function stopModelDownloadPolling() {
  if (modelDownloadPoller) {
    clearInterval(modelDownloadPoller);
    modelDownloadPoller = null;
  }
}

function renderDownloadTask(t) {
  document.getElementById("model-task-name").textContent =
    `${t.model_id} → models/${t.target_name}`;
  const stateEl = document.getElementById("model-task-state");
  stateEl.textContent = stateLabel(t.state);
  stateEl.className = `model-task-state state-${t.state}`;
  const fill = document.getElementById("model-task-bar-fill");
  fill.style.width = `${t.percent}%`;
  document.getElementById("model-task-pct").textContent = `${t.percent}%`;

  const fdone = t.files_done;
  const ftot = t.files_total;
  const human = (n) => {
    if (n < 1024) return `${n} B`;
    const u = ["KB","MB","GB","TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${u[i]}`;
  };
  const parts = [
    `${fdone}/${ftot} 文件`,
    `${human(t.bytes_done)} / ${human(t.bytes_total)}`,
  ];
  if (t.state === "running" && t.speed_bps > 0) {
    parts.push(`${human(t.speed_bps)}/s`);
    if (t.eta_seconds != null) parts.push(`剩 ${formatEta(t.eta_seconds)}`);
  }
  if (t.error) parts.push(`错误：${t.error}`);
  document.getElementById("model-task-meta").textContent = parts.join(" · ");
}

function formatEta(seconds) {
  if (seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function stateLabel(s) {
  return ({ queued: "排队中", running: "下载中", done: "已完成", error: "失败" })[s] || s;
}

// 把模型管理页的下载控件挂上事件 — 在 setupHotwords 旁边调用

// ---------- 模型搜索 ----------
let modelSearchTimer = null;
let modelSearchSeq = 0;

function setupModelSearch() {
  const input = document.getElementById("model-search-input");
  const clearBtn = document.getElementById("model-search-clear");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearBtn.hidden = q.length === 0;
    if (modelSearchTimer) clearTimeout(modelSearchTimer);
    if (!q) {
      renderSearchResults([], 0, "");
      hideSearchStatus();
      return;
    }
    modelSearchTimer = setTimeout(() => runModelSearch(q), 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (modelSearchTimer) clearTimeout(modelSearchTimer);
      runModelSearch(input.value.trim());
    }
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    renderSearchResults([], 0, "");
    hideSearchStatus();
    input.focus();
  });
}

async function runModelSearch(q) {
  if (!q) return;
  const seq = ++modelSearchSeq;
  showSearchStatus(`正在搜索「${q}」…`);
  try {
    const r = await fetch(`/api/models/search?q=${encodeURIComponent(q)}&page_size=20`);
    const body = await r.json();
    if (seq !== modelSearchSeq) return;  // 过期响应丢弃
    if (!r.ok) {
      showSearchStatus(`搜索失败：${body.error || r.status}`, true);
      renderSearchResults([], 0, q);
      return;
    }
    if (!body.items.length) {
      showSearchStatus(`没有匹配「${q}」的模型`);
    } else {
      hideSearchStatus();
    }
    renderSearchResults(body.items, body.total, q);
  } catch (err) {
    if (seq !== modelSearchSeq) return;
    showSearchStatus(`请求失败：${err.message || err}`, true);
  }
}

function renderSearchResults(items, total, q) {
  const el = document.getElementById("model-search-results");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = "";
    return;
  }
  // 按"是 ASR"优先 + 下载量降序
  const sorted = items.slice().sort((a, b) => {
    if (a.is_asr !== b.is_asr) return a.is_asr ? -1 : 1;
    return (b.downloads || 0) - (a.downloads || 0);
  });
  const head = `<li class="search-summary">「${escape(q)}」匹配 ${total} 个模型，显示前 ${items.length} 个（ASR 优先）</li>`;
  el.innerHTML = head + sorted.map(renderSearchHit).join("");
  el.onclick = handleModelAction;
}

function renderSearchHit(it) {
  const stateBadge = it.is_current
    ? '<span class="model-badge model-badge-current">当前激活</span>'
    : (it.downloaded ? '<span class="model-badge model-badge-downloaded">已下载</span>' : "");
  const asrBadge = it.is_asr
    ? '<span class="model-badge model-badge-asr">ASR</span>'
    : '<span class="model-badge model-badge-soft">非 ASR</span>';
  const action = it.downloaded
    ? (it.is_current
        ? ""
        : `<button class="model-act-btn model-act-activate" data-action="activate" data-name="${escape(it.name)}">使用此模型</button>`)
    : `<button class="model-act-btn model-act-download" data-action="download" data-id="${escape(it.model_id)}">下载</button>`;

  const dlText = it.downloads >= 10000
    ? `${(it.downloads / 10000).toFixed(1)} 万下载`
    : `${it.downloads} 下载`;

  return `
    <li class="search-hit${it.is_current ? " is-current" : ""}${it.is_asr ? "" : " is-non-asr"}">
      <div class="search-hit-main">
        <span class="search-hit-id" title="${escape(it.model_id)}">${escape(it.model_id)}</span>
        ${asrBadge}
        ${stateBadge}
        ${it.chinese_name ? `<span class="search-hit-cn">${escape(it.chinese_name)}</span>` : ""}
      </div>
      <div class="search-hit-aside">
        <span class="search-hit-meta">${escape(dlText)}${it.stars ? ` · ★ ${it.stars}` : ""}</span>
        ${action}
      </div>
      ${it.tasks.length ? `<div class="search-hit-tasks">${it.tasks.map((t) => `<span class="task-chip">${escape(t)}</span>`).join("")}</div>` : ""}
    </li>
  `;
}

function showSearchStatus(text, isError = false) {
  const el = document.getElementById("model-search-status");
  el.textContent = text;
  el.classList.toggle("is-error", !!isError);
  el.hidden = false;
}

function hideSearchStatus() {
  const el = document.getElementById("model-search-status");
  el.hidden = true;
  el.textContent = "";
}
