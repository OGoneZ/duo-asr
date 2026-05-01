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
const fmtMs = (ms) => (ms ? `${Math.round(ms)} ms` : "—");

const escape = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// ---------- 路由（hash-based） ----------
const VIEWS = ["home", "history"];
let currentView = "home";

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
  else if (view === "history") loadHistory();
}

// ---------- 首页 ----------
let dailyChart = null;
let clientChart = null;
let currentDays = 30;

async function loadHome() {
  await Promise.all([loadSummary(), loadDaily(currentDays), loadByClient(currentDays)]);
}

async function loadSummary() {
  const s = await fetchJSON("/api/stats/summary");
  document.getElementById("stat-chars").textContent = fmtNum(s.total_chars);
  document.getElementById("stat-keystrokes").textContent = fmtNum(s.total_keystrokes);
  document.getElementById("stat-duration").textContent = fmtDuration(s.total_duration_sec);
  document.getElementById("stat-cpm").textContent = s.chars_per_minute || "—";
  document.getElementById("stat-inference").textContent = fmtMs(s.avg_inference_ms);
  document.getElementById("stat-count").textContent = `${fmtNum(s.total_count)} 次转录`;
  if (s.error_count > 0) {
    document.getElementById("stat-error-count").textContent = `+${s.error_count} 次失败`;
  } else {
    document.getElementById("stat-error-count").textContent = "";
  }
  if (s.first_at) {
    document.getElementById("stat-period").textContent = `自 ${s.first_at.slice(0, 10)}`;
  }
  document.getElementById("last-update").textContent =
    `更新 ${new Date().toLocaleTimeString()}`;
}

async function loadDaily(days) {
  const data = await fetchJSON(`/api/stats/daily?days=${days}`);
  const map = new Map(data.map((d) => [d.day, d]));
  const labels = [];
  const chars = [];
  const durations = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = dt.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    const row = map.get(key);
    chars.push(row ? row.chars : 0);
    durations.push(row ? Math.round(row.duration_sec / 60) : 0);
  }

  const ctx = document.getElementById("daily-chart").getContext("2d");
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "字数",
          data: chars,
          backgroundColor: "rgba(94, 179, 255, 0.65)",
          borderRadius: 3,
          yAxisID: "y",
        },
        {
          type: "line",
          label: "时长(分)",
          data: durations,
          borderColor: "#6bd97e",
          backgroundColor: "rgba(107, 217, 126, 0.1)",
          tension: 0.3,
          pointRadius: 2,
          yAxisID: "y1",
        },
      ],
    },
    options: chartCommonOptions({ leftLabel: "字数", rightLabel: "时长(分)" }),
  });
}

async function loadByClient(days) {
  const data = await fetchJSON(`/api/stats/by-client?days=${days}`);
  const labels = data.map((d) => d.client);
  const chars = data.map((d) => d.chars);

  const ctx = document.getElementById("client-chart").getContext("2d");
  if (clientChart) clientChart.destroy();

  if (data.length === 0) {
    return; // 让 canvas 留空
  }

  const palette = ["#5eb3ff", "#6bd97e", "#ffb454", "#ff7b72", "#bd93f9", "#8be9fd", "#f1fa8c"];
  clientChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: chars,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderColor: "#1a1f29",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#9ba3af", font: { size: 12 }, boxWidth: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const row = data[ctx.dataIndex];
              const min = Math.round(row.duration_sec / 60);
              return `${row.client}: ${fmtNum(row.chars)} 字 · ${min} 分 · ${row.count} 次`;
            },
          },
        },
      },
    },
  });
}

function chartCommonOptions({ leftLabel, rightLabel }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: "#9ba3af", usePointStyle: true, pointStyle: "rectRounded" },
      },
      tooltip: { mode: "index", intersect: false },
    },
    scales: {
      x: {
        ticks: { color: "#9ba3af", maxRotation: 0, autoSkip: true },
        grid: { display: false },
      },
      y: {
        position: "left",
        ticks: { color: "#9ba3af" },
        grid: { color: "#2a313e" },
        title: { display: true, text: leftLabel, color: "#9ba3af" },
      },
      y1: {
        position: "right",
        ticks: { color: "#9ba3af" },
        grid: { display: false },
        title: { display: true, text: rightLabel, color: "#9ba3af" },
      },
    },
  };
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
        <span class="recent-meta">${item.char_count || 0} 字 · ${durStr} · ${fmtMs(item.inference_ms)}</span>
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
  // 时段切换（仅首页生效）
  document.querySelectorAll("#period-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#period-switch button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.dataset.days, 10);
      loadDaily(currentDays);
      loadByClient(currentDays);
    });
  });

  // 加载更多
  document.getElementById("load-more-btn").addEventListener("click", () => loadHistory(false));

  // 路由
  window.addEventListener("hashchange", syncRoute);
  syncRoute();

  // 自动刷新（仅首页 summary）
  setInterval(() => {
    if (currentView === "home") loadSummary();
  }, 30000);
});
