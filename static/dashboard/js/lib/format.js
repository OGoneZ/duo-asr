// 数值与时间格式化工具
export const fmtNum = (n) => (n ?? 0).toLocaleString();

// 累计转录时长："X 时 Y 分" / "X 分 Y 秒"
export const fmtDurationCombo = (sec) => {
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
export const fmtSecondsValue = (ms) => {
  if (!ms) return "—";
  const sec = ms / 1000;
  if (sec < 10) return sec.toFixed(2);
  return sec.toFixed(1);
};

export const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
};

export const fmtSeconds = (ms) => {
  if (!ms) return "—";
  const sec = ms / 1000;
  if (sec < 1) return sec.toFixed(2) + " s";
  if (sec < 10) return sec.toFixed(2) + " s";
  return sec.toFixed(1) + " s";
};

// 字节人类可读
export const human = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
};

// 下载剩余时间
export function formatEta(seconds) {
  if (seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// 模型参数规模标签
export function formatParams(b) {
  if (b == null) return "";
  if (b >= 1) return `${b}B`;
  return `${Math.round(b * 1000)}M`;
}

// 显存估算：bytes_per_param 按精度查表 × 1.2 overhead
const _BYTES_PER_PARAM = {
  "FP32": 4, "BF32": 4,
  "FP16": 2, "BF16": 2, "F16": 2,
  "FP8": 1, "F8": 1,
  "INT8": 1, "W8A16": 1, "Q8": 1.06,
  "INT4": 0.5, "W4A16": 0.5, "Q4": 0.55, "GGUF Q4": 0.55, "GGUF-Q4": 0.55,
  "INT2": 0.3,
};

export function estimateVram(paramsB, precision) {
  if (!paramsB) return null;
  const bpp = _BYTES_PER_PARAM[(precision || "FP16").toUpperCase()] ?? 2;
  const gb = paramsB * bpp * 1.2;
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${gb.toFixed(1)} GB`;
}

// 本地日期 YYYY-MM-DD —— 与后端 DATE(..., 'localtime') 输出一致
export function localDateKey(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
