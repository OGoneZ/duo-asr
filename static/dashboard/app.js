// ---------- 工具 ----------
const fmtNum = (n) => (n ?? 0).toLocaleString();

const fmtDuration = (sec) => {
  if (!sec) return "0 分";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} 时 ${m} 分`;
  return `${m} 分钟`;
};

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
let currentView = "home";
let currentDays = 30;
let currentClient = "all";    // "all" 或具体 client_host
let knownClients = [];

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
  document.getElementById("stat-duration").textContent = fmtDuration(s.total_duration_sec);
  document.getElementById("stat-cpm").textContent = s.chars_per_minute || "—";
  document.getElementById("stat-inference").textContent = fmtSeconds(s.avg_inference_ms);
  document.getElementById("stat-avg-dur").textContent = s.avg_duration_sec
    ? `${s.avg_duration_sec} s`
    : "—";

  document.getElementById("stat-count").textContent = `${fmtNum(s.total_count)} 次转录`;
  document.getElementById("stat-period").textContent = s.first_at
    ? `自 ${s.first_at.slice(0, 10)}`
    : "";
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
    li.className = "recent-item";
    li.dataset.id = item.id;

    const errorTag = item.error ? '<span class="error-tag">失败</span>' : "";
    const durStr = item.audio_duration ? `${item.audio_duration.toFixed(1)}s` : "—";
    const previewText = item.text_final || item.error || "(空)";

    li.innerHTML = `
      <div class="recent-line">
        <span class="recent-time">${fmtTime(item.created_at)}</span>
        <span class="recent-text">${escape(previewText)}${errorTag}</span>
        <span class="recent-meta">${item.char_count || 0} 字 · ${durStr} · ${fmtSeconds(item.inference_ms)}</span>
      </div>
      <div class="recent-detail"></div>
    `;
    li.addEventListener("click", () => toggleDetail(li, item));
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
  const rawHtml = item.text_raw
    ? `<div class="diff-label">原始转录</div><div class="diff-block">${escape(item.text_raw)}</div>`
    : "";
  const finalHtml = item.text_final && !sameRaw
    ? `<div class="diff-label">后处理后</div><div class="diff-block">${escape(item.text_final)}</div>`
    : "";
  const errorHtml = item.error
    ? `<div class="diff-label">错误</div><div class="diff-block">${escape(item.error)}</div>`
    : "";
  const audioHtml = item.error
    ? ""
    : `<div class="diff-label">原始音频</div>
       <audio controls preload="none" src="/api/recordings/${item.id}/audio"></audio>`;
  const meta = `
    <div class="diff-label">
      ${escape(item.client_host || "")}${item.client_ip ? ` (${escape(item.client_ip)})` : ""}
      · ${item.keystroke_count || 0} 次击键
    </div>
  `;

  detailEl.innerHTML = rawHtml + finalHtml + errorHtml + audioHtml + meta;
  detailEl.dataset.loaded = "1";
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

  setInterval(() => {
    if (currentView === "home") {
      loadClients();
      loadSummary();
    }
  }, 30000);
});
