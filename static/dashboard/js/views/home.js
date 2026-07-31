// 首页：概览 hero + 6 张统计卡 + 折线图
import { fetchJSON } from "../lib/fetch.js";
import { escape } from "../lib/escape.js";
import {
  fmtNum, fmtDurationCombo, fmtSecondsValue, localDateKey,
} from "../lib/format.js";
import { onThemeChange } from "../lib/theme.js";

let dailyChart = null;
let currentDays = 30;
let currentClient = "all";
let knownClients = [];
let pollHandle = null;
let unsubTheme = null;

export async function mount() {
  // 时段切换按钮
  document.querySelectorAll("#period-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#period-switch button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.dataset.days, 10);
      loadSummary();
      loadDaily();
    });
  });

  // 客户端 dropdown
  document.getElementById("client-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = document.getElementById("client-dropdown").classList.contains("open");
    open ? closeDropdown() : openDropdown();
  });
  document.addEventListener("click", _onDocClick);

  // 主题切换时重绘图表（CSS 变量取色）
  unsubTheme = onThemeChange(() => loadDaily());

  // 30s 轮询：仅在首页激活时
  pollHandle = setInterval(() => {
    loadClients();
    loadSummary();
  }, 30000);

  await loadClients();
  await Promise.all([loadSummary(), loadDaily()]);
}

export function unmount() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  if (unsubTheme) { unsubTheme(); unsubTheme = null; }
  document.removeEventListener("click", _onDocClick);
  if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
}

function _onDocClick(e) {
  const dd = document.getElementById("client-dropdown");
  if (dd && !dd.contains(e.target)) closeDropdown();
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

  document.getElementById("stat-duration").textContent = fmtDurationCombo(s.total_duration_sec);
  document.getElementById("stat-duration-unit").textContent = "";

  document.getElementById("stat-avg-dur").textContent =
    s.avg_duration_sec ? s.avg_duration_sec : "—";
  document.getElementById("stat-cpm").textContent = s.chars_per_minute || "—";
  document.getElementById("stat-inference").textContent = fmtSecondsValue(s.avg_inference_ms);
  document.getElementById("stat-postprocess").textContent = fmtSecondsValue(s.avg_postprocess_ms);

  document.getElementById("last-update").textContent =
    `更新 ${new Date().toLocaleTimeString()}`;

  // hero banner：已运行天数 + 节省时间
  let usedDays = "—";
  if (s.first_used_at) {
    const first = new Date(s.first_used_at);
    const ms = Date.now() - first.getTime();
    usedDays = Math.max(1, Math.floor(ms / 86400000));
  }
  document.getElementById("hero-days").textContent = usedDays;

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

  // 从最早有数据的那天开始显示，避免前面大片空白
  let startIdx = 0;
  while (startIdx < labels.length - 1) {
    if (chars[startIdx] > 0 || durations[startIdx] > 0) break;
    startIdx++;
  }
  if (startIdx > 0) {
    labels.splice(0, startIdx);
    chars.splice(0, startIdx);
    durations.splice(0, startIdx);
  }

  const niceRange = (vals) => {
    const filtered = vals.filter((v) => v > 0);
    if (filtered.length === 0) return { min: 0, max: 1 };
    const mx = Math.max(...filtered);
    const mn = Math.min(...filtered);
    const span = mx - mn;
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
