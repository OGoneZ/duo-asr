// 模型管理：已下载列表 + 推荐 family + 下载 + 搜索 + 切换 + 删除
import { fetchJSON } from "../lib/fetch.js";
import { escape } from "../lib/escape.js";
import {
  human, formatEta, formatParams, estimateVram,
} from "../lib/format.js";
import { customConfirm } from "../lib/dialog.js";

let modelDownloadPoller = null;
let modelDownloadActiveTaskId = null;
let modelSearchTimer = null;
let modelSearchSeq = 0;

export async function mount() {
  // 自定义下载输入框（推荐区下面 details 折叠区）
  const customBtn = document.getElementById("model-download-btn");
  const customInput = document.getElementById("model-download-id");
  if (customBtn && customInput) {
    customBtn.addEventListener("click", () => triggerModelDownload(customInput.value.trim(), customBtn));
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") triggerModelDownload(customInput.value.trim(), customBtn);
    });
  }

  // 搜索框
  const searchInput = document.getElementById("model-search-input");
  const clearBtn = document.getElementById("model-search-clear");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim();
      clearBtn.hidden = q.length === 0;
      if (modelSearchTimer) clearTimeout(modelSearchTimer);
      if (!q) {
        renderSearchResults([], 0, "");
        hideSearchStatus();
        return;
      }
      modelSearchTimer = setTimeout(() => runModelSearch(q), 300);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (modelSearchTimer) clearTimeout(modelSearchTimer);
        runModelSearch(searchInput.value.trim());
      }
    });
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearBtn.hidden = true;
      renderSearchResults([], 0, "");
      hideSearchStatus();
      searchInput.focus();
    });
  }

  // 暂停 / 取消按钮
  const pauseBtn = document.getElementById("model-task-pause");
  const cancelBtn = document.getElementById("model-task-cancel");
  if (pauseBtn) pauseBtn.addEventListener("click", () => pauseDownload());
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelDownload());

  await loadModels();
}

export function unmount() {
  stopModelDownloadPolling();
  if (modelSearchTimer) { clearTimeout(modelSearchTimer); modelSearchTimer = null; }
}

async function pauseDownload() {
  if (!modelDownloadActiveTaskId) return;
  const ok = await customConfirm({
    title: "暂停下载",
    message: "暂停后会保留已下载文件，下次点「继续下载」会从断点续传。",
    confirmText: "暂停",
  });
  if (!ok) return;
  try {
    const r = await fetch(`/api/models/download/${modelDownloadActiveTaskId}/cancel`, { method: "POST" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      showModelsError(`暂停失败：${body.error || r.status}`);
      return;
    }
    // polling 会观察到 state=cancelled 自动停下，并刷新列表显示「未下完」
  } catch (err) {
    showModelsError(`暂停失败：${err.message || err}`);
  }
}

async function cancelDownload() {
  if (!modelDownloadActiveTaskId) return;
  // 取消时需要任务的 target_name 来删除目录
  let targetName = null;
  try {
    const t = await fetchJSON(`/api/models/download/${modelDownloadActiveTaskId}`);
    targetName = t.target_name;
  } catch {}

  const ok = await customConfirm({
    title: "取消下载",
    message: "取消并删除所有已下载文件，无法恢复。",
    confirmText: "取消下载",
    danger: true,
  });
  if (!ok) return;
  try {
    // 1. 先 cancel 任务（避免删目录时仍在写）
    await fetch(`/api/models/download/${modelDownloadActiveTaskId}/cancel`, { method: "POST" });
    // 2. 等任务真停下来（最多 3 秒）
    for (let i = 0; i < 6; i++) {
      const t = await fetchJSON(`/api/models/download/${modelDownloadActiveTaskId}`);
      if (t.state !== "queued" && t.state !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // 3. 删目录
    if (targetName) {
      await fetch(`/api/models/${encodeURIComponent(targetName)}`, { method: "DELETE" });
    }
    stopModelDownloadPolling();
    document.getElementById("model-task-card").hidden = true;
    await loadModels();
  } catch (err) {
    showModelsError(`取消失败：${err.message || err}`);
  }
}

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
    const incompleteNames = new Set(
      (data.items || []).filter((m) => m.complete === false).map((m) => m.name),
    );
    document.getElementById("models-meta").textContent =
      `${data.items.length} 个已下载 · ${escape(data.models_dir)}`;
    renderModels(data.items, data.active, downloadingNames);
    renderRecommended(data.recommended || [], downloadingNames, incompleteNames);
  } catch (err) {
    showModelsError(`加载失败：${escape(err.message || err)}`);
    el.innerHTML = "";
    return;
  }
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
    const incomplete = m.complete === false;   // 留有 modelscope 残留临时目录
    const downloadingBadge = downloading
      ? '<span class="model-badge model-badge-downloading">下载中</span>'
      : "";
    const incompleteBadge = (incomplete && !downloading)
      ? '<span class="model-badge model-badge-warn">未下完</span>'
      : "";
    const showActions = !downloading;
    // incomplete 模型禁止 activate（加载会失败）；可以删除 / 重新下载
    const canActivate = showActions && !m.is_current && m.valid && !incomplete;
    return `
    <li class="model-card${m.is_current ? " is-current" : ""}${m.valid ? "" : " is-invalid"}${downloading ? " is-downloading" : ""}${incomplete ? " is-incomplete" : ""}">
      <div class="model-card-head">
        <div class="model-card-title">
          <span class="model-name">${escape(m.name)}</span>
          ${m.is_current ? '<span class="model-badge model-badge-current">当前激活</span>' : ""}
          ${downloadingBadge}
          ${incompleteBadge}
          ${m.valid || downloading || incomplete ? "" : '<span class="model-badge model-badge-warn">无 config 文件</span>'}
        </div>
        <div class="model-card-right">
          <span class="model-size">${escape(m.size_human)}</span>
          <div class="model-actions">
            ${canActivate ? `<button class="model-act-btn model-act-activate" data-action="activate" data-name="${escape(m.name)}">使用此模型</button>` : ""}
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

function renderRecommended(families, downloadingNames = new Set(), incompleteNames = new Set()) {
  const el = document.getElementById("models-recommended");
  if (!el) return;
  if (!families.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = families.map((f) => renderFamilyCard(f, downloadingNames, incompleteNames)).join("");
  el.onclick = handleModelAction;
}

function renderFamilyCard(f, downloadingNames = new Set(), incompleteNames = new Set()) {
  const downloadedCount = f.variants.filter((v) => v.downloaded).length;
  const statusBadge = f.any_current
    ? '<span class="model-badge model-badge-current">当前激活</span>'
    : (downloadedCount > 0
        ? `<span class="model-badge model-badge-downloaded">${downloadedCount}/${f.variant_count} 已下载</span>`
        : `<span class="model-badge model-badge-soft">${f.variant_count} 个版本</span>`);

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
          ${f.variants.map((v) => renderVariantRow(v, downloadingNames, incompleteNames)).join("")}
        </ul>
      </details>
    </li>
  `;
}

function renderVariantRow(v, downloadingNames = new Set(), incompleteNames = new Set()) {
  const downloading = downloadingNames.has(v.target_name);
  const incomplete = !downloading && incompleteNames.has(v.target_name);
  const stateBadge = downloading
    ? '<span class="model-badge model-badge-downloading">下载中</span>'
    : (incomplete
        ? '<span class="model-badge model-badge-warn">未下完</span>'
        : (v.is_current
            ? '<span class="model-badge model-badge-current">当前激活</span>'
            : (v.downloaded ? '<span class="model-badge model-badge-downloaded">已下载</span>' : "")));
  let action;
  if (downloading) {
    action = "";
  } else if (incomplete) {
    // 未下完的模型显示「继续下载」按钮（modelscope 自动续传）
    action = `<button class="model-act-btn model-act-download" data-action="download" data-id="${escape(v.model_id)}">继续下载</button>`;
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

// ---- 下载 ----
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
      if (data.state === "done" || data.state === "error" || data.state === "cancelled") {
        stopModelDownloadPolling();
        // 任务结束 → 隐藏进度卡 + 刷新列表（让 incomplete 状态正确显示）
        if (data.state !== "running") {
          document.getElementById("model-task-card").hidden = true;
        }
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

function stateLabel(s) {
  return ({
    queued: "排队中", running: "下载中",
    done: "已完成", error: "失败", cancelled: "已暂停",
  })[s] || s;
}

// ---- 搜索 ----
async function runModelSearch(q) {
  if (!q) return;
  const seq = ++modelSearchSeq;
  showSearchStatus(`正在搜索「${q}」…`);
  try {
    const r = await fetch(`/api/models/search?q=${encodeURIComponent(q)}&page_size=20`);
    const body = await r.json();
    if (seq !== modelSearchSeq) return;
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
