// HTML / 正则转义、字符级 diff、关键词高亮
export const escape = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 转义字符串里的 regex 元字符
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 字符级 diff（基于 LCS）。返回合并后的 ops 数组
export function diffChars(a, b) {
  a = a || ""; b = b || "";
  const m = a.length, n = b.length;
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
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}

export function renderDiff(raw, final) {
  return diffChars(raw, final).map((op) => {
    const t = escape(op.text);
    if (op.type === "equal") return t;
    if (op.type === "delete") return `<del>${t}</del>`;
    return `<ins>${t}</ins>`;
  }).join("");
}

// 转义文本后，再把 query 命中的部分包成 <mark>。query 为空 → 等价于 escape
export function highlight(text, query) {
  const safe = escape(text);
  if (!query) return safe;
  const re = new RegExp(escapeRegex(escape(query)), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
