// 入口：路由 + 全局基础设施（主题、音频互斥、view 动态注入）
import { applyTheme, readTheme, toggleTheme } from "./lib/theme.js";

const ROUTES = {
  home:       () => import("./views/home.js"),
  history:    () => import("./views/history.js"),
  transcribe: () => import("./views/transcribe.js"),
  hotwords:   () => import("./views/hotwords.js"),
  models:     () => import("./views/models.js"),
};

// 启动时立刻应用主题，避免闪白
applyTheme(readTheme());

let currentView = null;
let currentModule = null;

async function navigate() {
  const hash = location.hash.replace(/^#\//, "") || "home";
  const view = (hash in ROUTES) ? hash : "home";
  if (view === currentView) return;

  // 卸载旧 view
  if (currentModule?.unmount) {
    try { await currentModule.unmount(); } catch (e) { console.error(e); }
  }
  currentView = view;
  currentModule = null;

  // sidebar nav 高亮
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });

  // 注入 fragment
  const main = document.getElementById("main-content");
  try {
    const r = await fetch(`views/${view}.html`);
    if (!r.ok) throw new Error(`view ${view} → ${r.status}`);
    main.innerHTML = await r.text();
  } catch (err) {
    main.innerHTML = `<div style="padding:32px;color:#f87171">页面加载失败：${err.message}</div>`;
    return;
  }

  // 加载并 mount view module
  try {
    const mod = await ROUTES[view]();
    await mod.mount?.();
    currentModule = mod;
  } catch (err) {
    console.error(`mount ${view} failed`, err);
    main.innerHTML = `<div style="padding:32px;color:#f87171">视图初始化失败：${err.message}</div>`;
  }
}

// 全局事件（一次性）：主题切换 + 音频互斥
function setupGlobalListeners() {
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

  // 音频互斥播放：开始播一个时，自动暂停其他
  document.addEventListener("play", (e) => {
    if (e.target.tagName !== "AUDIO") return;
    document.querySelectorAll("audio").forEach((other) => {
      if (other !== e.target && !other.paused) other.pause();
    });
  }, true);
}

document.addEventListener("DOMContentLoaded", () => {
  setupGlobalListeners();
  window.addEventListener("hashchange", navigate);
  navigate();
});
