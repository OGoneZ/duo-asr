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
  else if (view === "history") loadHistory(true);
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
  const s = await fetchJSON(`/api/stats/summary?_=1${clientQuery()}`);
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
        legend: {
          align: "end",
          labels: { color: fg, usePointStyle: true, pointStyle: "rectRounded", boxWidth: 6, boxHeight: 6 },
        },
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

async function loadHistory(reset = true) {
  if (reset) {
    historyOffset = 0;
    historyHasMore = true;
    document.getElementById("recent-list").innerHTML = "";
  }
  if (!historyHasMore) return;

  const items = await fetchJSON(`/api/stats/recent?n=${PAGE_SIZE}&offset=${historyOffset}`);
  appendHistoryItems(items);
  historyOffset += items.length;
  historyHasMore = items.length === PAGE_SIZE;

  const btn = document.getElementById("load-more-btn");
  btn.disabled = !historyHasMore;
  btn.textContent = historyHasMore ? "加载更多" : "没有更多了";

  document.getElementById("history-count").textContent = `已加载 ${historyOffset} 条`;
}

function appendHistoryItems(items) {
  const ul = document.getElementById("recent-list");
  if (historyOffset === 0 && items.length === 0) {
    ul.innerHTML = '<li class="muted" style="padding:14px">还没有转录记录。</li>';
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "recent-item" + (item.error ? " has-error" : "");
    li.dataset.id = item.id;

    const previewText = item.text_final || item.error || "(空)";
    const durLabel = item.audio_duration ? `${item.audio_duration.toFixed(1)}s` : "—";
    const clientLabel = item.client_host || item.client_ip || "unknown";

    li.innerHTML = `
      <div class="recent-head">
        <div class="recent-meta-line">
          <span class="recent-date">${fmtTime(item.created_at)}</span>
          <span class="recent-client">${escape(clientLabel)}</span>
          ${item.error ? '<span class="error-tag">失败</span>' : ""}
        </div>
        <span class="recent-duration">${durLabel}</span>
      </div>
      <div class="recent-text">${escape(previewText)}</div>
      <div class="recent-detail"></div>
    `;
    li.addEventListener("click", (e) => {
      // 点 audio / copy 按钮时不要折叠
      if (e.target.closest("audio, .btn-copy")) return;
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
      html += `
        <div class="detail-section">
          <div class="detail-section-head">
            <span class="detail-label">${sameRaw ? "转录文本" : "后处理后"}</span>
            <button class="btn-copy" data-copy="final">⧉ 复制</button>
          </div>
          <div class="detail-text">${escape(item.text_final)}</div>
        </div>`;
    }
    if (item.text_raw && !sameRaw) {
      html += `
        <div class="detail-section">
          <div class="detail-section-head">
            <span class="detail-label">原始转录</span>
          </div>
          <div class="detail-text-raw">${escape(item.text_raw)}</div>
        </div>`;
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
          <div class="detail-meta-label"><span class="detail-meta-icon">${icon}</span>${label}</div>
          <div class="detail-meta-value">${value}</div>`
          )
          .join("")}
      </div>
    </div>`;

  detailEl.innerHTML = html;
  detailEl.dataset.loaded = "1";

  detailEl.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const which = btn.dataset.copy;
      const text = which === "raw" ? item.text_raw : item.text_final;
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
      loadDaily();
    });
  });

  document.getElementById("load-more-btn").addEventListener("click", () => loadHistory(false));

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
