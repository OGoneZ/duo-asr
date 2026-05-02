// 热词管理：表格 / 原文 双视图编辑 + 保存
import { fetchJSON } from "../lib/fetch.js";
import { escape } from "../lib/escape.js";

let hotwordsRows = [];
let hotwordsMode = "table";   // "table" | "raw"
let hotwordsRawText = "";
let flashTimer = null;

export async function mount() {
  // 模式切换
  document.querySelectorAll("#hotwords-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.mode;
      if (next === hotwordsMode) return;
      if (hotwordsMode === "table" && next === "raw") {
        hotwordsRows = readRowsFromTable();
        hotwordsRawText = rowsToToml(hotwordsRows);
        document.getElementById("hotwords-raw").value = hotwordsRawText;
      } else if (hotwordsMode === "raw" && next === "table") {
        hotwordsRawText = document.getElementById("hotwords-raw").value;
      }
      hotwordsMode = next;
      syncHotwordsModeUI();
    });
  });

  document.getElementById("hotwords-add-btn").addEventListener("click", () => {
    if (hotwordsMode !== "table") return;
    hotwordsRows = readRowsFromTable();
    hotwordsRows.push({ target: "", variants: [], phonetic: false, pinyin: [] });
    renderHotwordsTable();
    const last = document.querySelector("#hotwords-tbody tr:last-child .hw-target");
    if (last) last.focus();
  });

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

  document.getElementById("hotwords-save-btn").addEventListener("click", saveHotwords);

  await loadHotwords();
}

export function unmount() {
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
}

async function loadHotwords() {
  const data = await fetchJSON("/api/hotwords");
  hotwordsRawText = data.text || "";
  hotwordsRows = parsedToRows(data.parsed);
  if (data.parsed === null) {
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
    tbody.innerHTML = `<tr class="hw-empty"><td colspan="5">暂无热词，点击下方「+ 新增热词」开始。</td></tr>`;
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

async function saveHotwords() {
  let text;
  if (hotwordsMode === "table") {
    hotwordsRows = readRowsFromTable();
    const empty = hotwordsRows.find((r) => !r.target && (r.variants.length || r.phonetic));
    if (empty) {
      showHotwordsError("有规则缺少目标词，请补全或删除该行。");
      return;
    }
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
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.classList.remove("ok");
    el.hidden = true;
    el.textContent = "";
    flashTimer = null;
  }, 2200);
}
