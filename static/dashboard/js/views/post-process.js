// 后处理模型管理：provider 切换 / 本地模型 / endpoint 配置 / prompt 编辑 / 测试
import { fetchJSON } from "../lib/fetch.js";
import { escape } from "../lib/escape.js";
import { customConfirm } from "../lib/dialog.js";

let searchTimer = null;
let searchSeq = 0;

export async function mount() {
  document.querySelectorAll("input[name='pp-provider']").forEach((radio) => {
    radio.addEventListener("change", () => {
      onProviderChange(radio.value);
      saveProvider(radio.value);
    });
  });
  document.getElementById("pp-endpoint-save").addEventListener("click", saveEndpoint);
  document.getElementById("pp-prompt-save").addEventListener("click", savePrompt);
  document.getElementById("pp-prompt-reload").addEventListener("click", reloadPrompt);

  const searchInput = document.getElementById("pp-search-input");
  const clearBtn = document.getElementById("pp-search-clear");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    clearBtn.hidden = q.length === 0;
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { renderSearchResults([], ""); hideSearchStatus(); return; }
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { if (searchTimer) clearTimeout(searchTimer); runSearch(searchInput.value.trim()); }
  });
  clearBtn.addEventListener("click", () => {
    searchInput.value = ""; clearBtn.hidden = true;
    renderSearchResults([], ""); hideSearchStatus(); searchInput.focus();
  });
  document.getElementById("pp-test-btn").addEventListener("click", runTest);
  await loadConfig();
}

export function unmount() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
}

// ── 配置加载 ──────────────────────────────────────────

async function loadConfig() {
  try {
    const cfg = await fetchJSON("/api/post-process/config");
    applyConfig(cfg);
  } catch (err) {
    showError(`加载失败: ${escape(err.message || err)}`);
  }
}

function applyConfig(cfg) {
  const radio = document.querySelector(`input[name='pp-provider'][value="${escape(cfg.provider)}"]`);
  if (radio) radio.checked = true;
  onProviderChange(cfg.provider);
  document.getElementById("pp-endpoint-url").value = cfg.endpoint_url || "";
  document.getElementById("pp-endpoint-key").value = cfg.endpoint_key || "";
  document.getElementById("pp-endpoint-model").value = cfg.endpoint_model || "";
  const prompt = cfg.prompt || cfg.default_prompt || "";
  document.getElementById("pp-prompt-textarea").value = prompt;
  renderRecommended(cfg.recommended || [], cfg.local_models || []);
  renderLocalModels(cfg.local_models || [], cfg.model_name);
}

function onProviderChange(provider) {
  document.getElementById("pp-local-section").hidden = provider !== "local";
  document.getElementById("pp-endpoint-section").hidden = provider !== "endpoint";
}

// ── 推荐模型 ──────────────────────────────────────────

function renderRecommended(recommended, localModels) {
  const el = document.getElementById("pp-recommended-list");
  if (!el) return;
  if (!recommended.length) { el.innerHTML = ""; return; }
  const downloadedModels = new Set(localModels.map((m) => m.name));
  el.innerHTML = recommended.map((r) => {
    const downloaded = downloadedModels.has(r.file_name);
    const isCurrent = r.file_name === localModels.find((m) => m.is_current)?.name;
    const action = downloaded
      ? (isCurrent ? "" : `<button class="pp-model-act-btn pp-model-act-activate" data-action="activate" data-name="${escape(r.file_name)}">使用此模型</button>`)
      : `<button class="model-act-btn model-act-download" data-action="download-rec" data-id="${escape(r.model_id)}" data-file="${escape(r.file_name)}">下载</button>`;
    return `<li class="pp-model-card${isCurrent ? " is-current" : ""}">
      <div class="pp-model-info">
        <span class="pp-model-name">${escape(r.name)}</span>
        ${isCurrent ? '<span class="model-badge model-badge-current">当前激活</span>' : (downloaded ? '<span class="model-badge model-badge-downloaded">已下载</span>' : "")}
        <span class="pp-model-size">${escape(r.size_human)}</span>
      </div>
      <div class="pp-model-actions">${action}</div>
      ${r.summary ? `<div class="variant-summary-line" style="grid-column:1/-1;padding:0">${escape(r.summary)}</div>` : ""}
    </li>`;
  }).join("");
  el.onclick = handleLocalAction;
}

// ── 已下载模型 ────────────────────────────────────────

function renderLocalModels(models, activeName) {
  const el = document.getElementById("pp-local-list");
  if (!models.length) {
    el.innerHTML = `<li class="pp-model-empty">尚未下载 LLM 模型。从下方搜索并下载，或从推荐区一键下载。</li>`;
    return;
  }
  el.innerHTML = models.map((m) => {
    const isCurrent = m.name === activeName;
    return `<li class="pp-model-card${isCurrent ? " is-current" : ""}">
      <div class="pp-model-info">
        <span class="pp-model-name" title="${escape(m.name)}">${escape(m.name)}</span>
        ${isCurrent ? '<span class="model-badge model-badge-current">当前激活</span>' : ""}
        <span class="pp-model-size">${escape(m.size_human)}</span>
      </div>
      <div class="pp-model-actions">
        ${isCurrent ? "" : `<button class="pp-model-act-btn pp-model-act-activate" data-action="activate" data-name="${escape(m.name)}">使用此模型</button>`}
        ${isCurrent ? "" : `<button class="pp-model-act-btn pp-model-act-delete" data-action="delete" data-name="${escape(m.name)}">删除</button>`}
      </div>
    </li>`;
  }).join("");
  el.onclick = handleLocalAction;
}

async function handleLocalAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "activate") return activateModel(btn.dataset.name, btn);
  if (action === "delete") return deleteModel(btn.dataset.name, btn);
  if (action === "download-rec") return downloadRecommended(btn.dataset.id, btn.dataset.file, btn);
}

async function downloadRecommended(modelId, fileName, btn) {
  btn.disabled = true; btn.textContent = "下载中…";
  try {
    const r = await fetch("/api/post-process/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId, file_name: fileName }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`下载失败: ${body.error || r.status}`); btn.disabled = false; btn.textContent = "下载"; return; }
    toast("模型下载完成"); hideError(); await loadConfig();
  } catch (err) { showError(`请求失败: ${err.message || err}`); btn.disabled = false; btn.textContent = "下载"; }
}

async function activateModel(name, btn) {
  const ok = await customConfirm({ title: "切换后处理模型", message: `将激活后处理模型为「${name}」？`, confirmText: "切换" });
  if (!ok) return;
  btn.disabled = true; btn.textContent = "切换中…";
  try {
    const r = await fetch("/api/post-process/active", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`切换失败: ${body.error || r.status}`); btn.disabled = false; btn.textContent = "使用此模型"; return; }
    hideError(); await loadConfig();
  } catch (err) { showError(`请求失败: ${err.message || err}`); btn.disabled = false; btn.textContent = "使用此模型"; }
}

async function deleteModel(name, btn) {
  const ok = await customConfirm({ title: "删除模型", message: `确认删除「${name}」？此操作无法撤销。`, confirmText: "删除", danger: true });
  if (!ok) return;
  btn.disabled = true; btn.textContent = "删除中…";
  try {
    const r = await fetch(`/api/post-process/models/${encodeURIComponent(name)}`, { method: "DELETE" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`删除失败: ${body.error || r.status}`); btn.disabled = false; btn.textContent = "删除"; return; }
    hideError(); await loadConfig();
  } catch (err) { showError(`请求失败: ${err.message || err}`); btn.disabled = false; btn.textContent = "删除"; }
}

// ── Endpoint ──────────────────────────────────────────

async function saveEndpoint() {
  const btn = document.getElementById("pp-endpoint-save");
  btn.disabled = true; btn.textContent = "保存中…";
  try {
    const r = await fetch("/api/post-process/config", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint_url: document.getElementById("pp-endpoint-url").value.trim(),
        endpoint_key: document.getElementById("pp-endpoint-key").value,
        endpoint_model: document.getElementById("pp-endpoint-model").value.trim(),
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`保存失败: ${body.error || r.status}`); } else { hideError(); toast("Endpoint 配置已保存"); }
  } catch (err) { showError(`请求失败: ${err.message || err}`); }
  btn.disabled = false; btn.textContent = "保存 Endpoint 配置";
}

async function savePrompt() {
  const btn = document.getElementById("pp-prompt-save");
  btn.disabled = true; btn.textContent = "保存中…";
  try {
    const r = await fetch("/api/post-process/config", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: document.getElementById("pp-prompt-textarea").value }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`保存失败: ${body.error || r.status}`); } else { hideError(); toast("Prompt 已保存"); }
  } catch (err) { showError(`请求失败: ${err.message || err}`); }
  btn.disabled = false; btn.textContent = "保存 Prompt";
}

async function reloadPrompt() {
  try {
    const r = await fetch("/api/post-process/prompt/reload", { method: "POST" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`加载失败: ${body.error || r.status}`); return; }
    document.getElementById("pp-prompt-textarea").value = body.default_prompt || body.prompt || "";
    hideError(); toast("已从 default_prompt.txt 重新加载");
  } catch (err) { showError(`请求失败: ${err.message || err}`); }
}

async function saveProvider(provider) {
  try {
    const r = await fetch("/api/post-process/config", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`保存失败: ${body.error || r.status}`); return; }
    hideError();
    toast(`已切换为「${{none: "不启用", local: "本地模型", endpoint: "自定义 Endpoint"}[provider]}」`);
    await loadConfig();
  } catch (err) { showError(`请求失败: ${err.message || err}`); }
}

// ── 搜索 ─────────────────────────────────────────────

async function runSearch(q) {
  if (!q) return;
  const seq = ++searchSeq;
  showSearchStatus(`正在搜索「${q}」…`);
  try {
    const r = await fetch(`/api/post-process/search?q=${encodeURIComponent(q)}&page_size=15`);
    const body = await r.json();
    if (seq !== searchSeq) return;
    if (!r.ok) { showSearchStatus(`搜索失败: ${body.error || r.status}`, true); renderSearchResults([], q); return; }
    if (!body.items.length) { showSearchStatus(`没有匹配「${q}」的模型`); } else { hideSearchStatus(); }
    renderSearchResults(body.items, q);
  } catch (err) { if (seq !== searchSeq) return; showSearchStatus(`请求失败: ${err.message || err}`, true); }
}

function renderSearchResults(items, q) {
  const el = document.getElementById("pp-search-results");
  if (!el) return;
  if (!items.length) { el.innerHTML = ""; return; }
  const head = q ? `<li class="search-summary">「${escape(q)}」匹配 ${items.length} 个模型</li>` : "";
  el.innerHTML = head + items.map((it) => {
    const targetName = it.model_id.split("/").pop();
    const stateBadge = it.is_current
      ? '<span class="model-badge model-badge-current">当前激活</span>'
      : (it.downloaded ? '<span class="model-badge model-badge-downloaded">已下载</span>' : "");
    const action = it.downloaded
      ? (it.is_current ? "" : `<button class="pp-model-act-btn pp-model-act-activate" data-action="activate" data-name="${escape(targetName)}">使用此模型</button>`)
      : `<button class="model-act-btn model-act-download" data-action="download-rec" data-id="${escape(it.model_id)}">下载</button>`;
    return `<li class="pp-search-hit${it.is_current ? " is-current" : ""}">
      <div class="pp-model-info">
        <span class="pp-model-name" title="${escape(it.model_id)}">${escape(it.model_id)}</span>${stateBadge}
      </div>
      <div class="pp-model-actions">${action}</div>
    </li>`;
  }).join("");
  el.onclick = handleLocalAction;
}

function showSearchStatus(text, isError) {
  const el = document.getElementById("pp-search-status");
  el.textContent = text; el.classList.toggle("is-error", !!isError); el.hidden = false;
}
function hideSearchStatus() { const el = document.getElementById("pp-search-status"); el.hidden = true; el.textContent = ""; }

// ── 测试 ─────────────────────────────────────────────

async function runTest() {
  const text = document.getElementById("pp-test-input").value.trim();
  if (!text) { showError("请输入测试文本"); return; }
  const btn = document.getElementById("pp-test-btn");
  const meta = document.getElementById("pp-test-meta");
  const compare = document.getElementById("pp-test-compare");
  btn.disabled = true; btn.textContent = "测试中…"; meta.hidden = true; compare.hidden = true;
  try {
    const r = await fetch("/api/post-process/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showError(`测试失败: ${body.error || r.status}`); btn.disabled = false; btn.textContent = "运行测试"; return; }
    hideError();
    document.getElementById("pp-test-original").textContent = text;
    document.getElementById("pp-test-result").textContent = body.result;
    meta.textContent = `耗时 ${body.elapsed_ms}ms · provider: ${body.provider}`;
    meta.hidden = false; compare.hidden = false;
  } catch (err) { showError(`请求失败: ${err.message || err}`); }
  btn.disabled = false; btn.textContent = "运行测试";
}

// ── 工具 ──────────────────────────────────────────────

function showError(msg) { const el = document.getElementById("pp-error"); el.textContent = msg; el.hidden = false; }
function hideError() { const el = document.getElementById("pp-error"); el.hidden = true; el.textContent = ""; }
function toast(msg) {
  const existing = document.querySelector(".pp-toast"); if (existing) existing.remove();
  const el = document.createElement("div"); el.className = "pp-toast"; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 0.3s"; }, 2500);
  setTimeout(() => el.remove(), 3000);
}
