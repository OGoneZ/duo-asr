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

// ---------- 状态 ----------
const VIEWS = ["home", "history"];
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

  // 30s 轮询首页 summary（仅在 home view，避开历史记录页）
  setInterval(() => {
    if (currentView === "home") {
      loadClients();
      loadSummary();
    }
  }, 30000);
});
