// 主题切换：dark / light 持久化到 localStorage
const THEME_KEY = "asr-panel-theme";
const _listeners = new Set();

export function readTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  for (const cb of _listeners) {
    try { cb(theme); } catch (e) { console.error(e); }
  }
}

export function toggleTheme() {
  const next = readTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// 注册主题变化回调（如图表重绘）。返回 unsubscribe 函数。
export function onThemeChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
