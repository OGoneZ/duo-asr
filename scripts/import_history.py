#!/usr/bin/env python3
"""一次性导入历史记录：mac VoiceInk + leju Yumo → 当前 transcriptions 表。

数据来源（本地暂存）：
  migration/mac-voiceink/default.store        Core Data store（SwiftData）
  migration/mac-voiceink/Recordings/          557 wav
  migration/leju-yumo/data.db                 Yumo 自建 SQLite
  migration/leju-yumo/recordings/             988 wav + 988 txt

策略：
  - macmini 端记录的 client_host 一律标 "macmini"，model_name 取 Core Data 字段
  - leju 端 client_host 标 "leju"，model_name 取 yumo 库的 model_name
  - leju 缺失 inference_ms：扫 mac ASR 服务日志（5 行块），文本完全相等且时间窗
    内匹配的，把"转写完成 耗时"补回去
  - 文件按 created_at 日期归档到 recordings/YYYY-MM-DD/<原文件名>，方案 A 保留原名
  - 幂等：用 (created_at, audio_filename) 双键查重，重跑只补缺失
"""
from __future__ import annotations

import argparse
import re
import shutil
import sqlite3
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

# 项目根 = scripts/.. = asr-server/
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import db  # noqa: E402
import stats as kstats  # noqa: E402

MIGRATION = ROOT / "migration"
MAC_STORE = MIGRATION / "mac-voiceink/default.store"
MAC_REC_DIR = MIGRATION / "mac-voiceink/Recordings"
YUMO_DB = MIGRATION / "leju-yumo/data.db"
YUMO_REC_DIR = MIGRATION / "leju-yumo/recordings"
LOG_DIR_MAC = ROOT / "logs"

# Apple 绝对时间起点（自 2001-01-01 00:00:00 UTC 的秒数）
APPLE_EPOCH = 978307200  # = datetime(2001,1,1, tzinfo=utc).timestamp()


def _normalize_model_name(name: str | None) -> str | None:
    """统一不同客户端对千问模型的写法 → "Qwen3-ASR-1.7B"。"""
    if not name:
        return name
    if name in {"Qwen3-ASR", "Qwen3 ASR", "qwen3-asr", "Qwen3-ASR-1.7B"}:
        return "Qwen3-ASR-1.7B"
    return name


# -------------------- mac VoiceInk --------------------

def iter_voiceink_records():
    """解析 mac VoiceInk default.store（Core Data SQLite）→ 标准化 dict。"""
    conn = sqlite3.connect(MAC_STORE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT Z_PK, ZTIMESTAMP, ZDURATION, ZTRANSCRIPTIONDURATION,
               ZAUDIOFILEURL, ZTEXT, ZENHANCEDTEXT, ZTRANSCRIPTIONMODELNAME
        FROM ZTRANSCRIPTION
        WHERE ZTIMESTAMP IS NOT NULL
        ORDER BY ZTIMESTAMP
    """).fetchall()
    conn.close()
    for r in rows:
        ts_apple = r["ZTIMESTAMP"]
        if ts_apple is None:
            continue
        # Apple 时间 → UTC ISO
        utc_dt = datetime.fromtimestamp(APPLE_EPOCH + ts_apple, tz=timezone.utc)
        url = r["ZAUDIOFILEURL"] or ""
        # ZAUDIOFILEURL 是 file:// URL，提取 basename
        path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
        filename = Path(path).name if path else None
        yield {
            "_source": "voiceink",
            "_pk": r["Z_PK"],
            "created_at_utc": utc_dt,
            "audio_filename": filename,
            "audio_duration": r["ZDURATION"],
            "inference_ms": int((r["ZTRANSCRIPTIONDURATION"] or 0) * 1000) or None,
            "text_raw": r["ZTEXT"],
            "text_final": r["ZENHANCEDTEXT"] or r["ZTEXT"],
            # VoiceInk 通常写 "Qwen3-ASR"，但实际后端就是 1.7B，统一命名
            "model_name": _normalize_model_name(r["ZTRANSCRIPTIONMODELNAME"] or "VoiceInk"),
            "client_host": "macmini",
            "client_ip": None,
            "src_dir": MAC_REC_DIR,
        }


# -------------------- leju Yumo --------------------

def iter_yumo_records():
    """解析 leju yumo data.db → 标准化 dict。"""
    conn = sqlite3.connect(YUMO_DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, text, enhanced_text, timestamp, duration, model_name, recording_path
        FROM transcriptions
        ORDER BY timestamp
    """).fetchall()
    conn.close()
    for r in rows:
        # yumo 写的是 "2026-04-30 12:31:09.925083" UTC（无时区标记）
        ts_str = r["timestamp"].split(".")[0]  # 去掉小数秒
        utc_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        rec_path = r["recording_path"] or ""
        filename = Path(rec_path).name if rec_path else None
        yield {
            "_source": "yumo",
            "_pk": r["id"],
            "created_at_utc": utc_dt,
            "audio_filename": filename,
            "audio_duration": r["duration"],
            "inference_ms": None,  # yumo 不记录，下面用日志补
            "text_raw": r["text"],
            "text_final": r["enhanced_text"] or r["text"],
            # yumo 库里写的是 "openai-compatible"（OpenAI 兼容协议），但实际后端
            # 就是我们的 ASR 服务 = Qwen3-ASR-1.7B。统一替换为真实模型名。
            "model_name": "Qwen3-ASR-1.7B",
            "client_host": "leju",
            "client_ip": None,
            "src_dir": YUMO_REC_DIR,
        }


# -------------------- mac ASR 日志解析（补 yumo inference_ms） --------------------

LOG_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) INFO (.*)$")
# 新格式：请求来源: leju (10.0.0.7) / macmini (10.0.0.4)
# 老格式：请求来源 IP: 127.0.0.1（4-19 起几天内，未接 Caddy XFF 时）
SRC_ANY = re.compile(r"请求来源[: ]")
RAW = re.compile(r"原始输出: (.*)$")
# 新格式：转写完成, 耗时: 1.47秒
# 老格式：转写完成, 耗时: 1.52秒, 结果: 测试一下...
ELAPSED_NEW = re.compile(r"转写完成, 耗时: ([\d.]+)秒$")
ELAPSED_OLD = re.compile(r"转写完成, 耗时: ([\d.]+)秒, 结果: (.*)$")

CST = timezone(timedelta(hours=8))


def parse_asr_logs() -> list[dict]:
    """扫 mac ASR 日志，返回每个完整请求块：{src_local, raw, elapsed_ms}

    兼容两种格式：
      - 新（4-24 起）：请求来源: <host> + 原始输出: <text> + 转写完成, 耗时: Xs
      - 老（4-19~4-23）：请求来源 IP: <ip> + 转写完成, 耗时: Xs, 结果: <text>
    老日志每行重复两次，按"时间戳+消息"相同的相邻行去重。
    """
    blocks: list[dict] = []
    for log_file in sorted(LOG_DIR_MAC.glob("*/*.log")):
        cur: dict | None = None
        prev_line: str | None = None
        for line in log_file.read_text(errors="ignore").splitlines():
            if line == prev_line:
                continue  # dedup 老 logger 重复的连续相同行
            prev_line = line
            m = LOG_LINE.match(line)
            if not m:
                continue
            ts_str, msg = m.groups()
            local_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)
            if SRC_ANY.search(msg):
                cur = {"src_local": local_dt, "raw": None, "elapsed_ms": None}
                blocks.append(cur)
            elif cur is not None and (rm := RAW.search(msg)):
                cur["raw"] = rm.group(1)
            elif cur is not None and (em := ELAPSED_OLD.search(msg)):
                # 老格式一行带 elapsed + raw
                cur["elapsed_ms"] = int(float(em.group(1)) * 1000)
                cur["raw"] = em.group(2)
                cur = None
            elif cur is not None and (em := ELAPSED_NEW.search(msg)):
                cur["elapsed_ms"] = int(float(em.group(1)) * 1000)
                cur = None
    blocks = [b for b in blocks if b.get("raw") and b.get("elapsed_ms") is not None]
    return blocks


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def attach_inference_ms(yumo_records: list[dict], log_blocks: list[dict]) -> tuple[int, int]:
    """按文本相等 + 时间窗匹配，给 yumo 记录写回 inference_ms。返回 (matched, total)。"""
    # 按 normalized text 索引日志块
    by_text: dict[str, list[dict]] = {}
    for blk in log_blocks:
        by_text.setdefault(_norm(blk["raw"]), []).append(blk)

    matched = 0
    for rec in yumo_records:
        if rec["text_raw"] is None:
            continue
        key = _norm(rec["text_raw"])
        candidates = by_text.get(key, [])
        if not candidates:
            continue
        # yumo timestamp 必然 ≥ src，且差 ≤ 30s（宽泛）
        rec_local = rec["created_at_utc"].astimezone(CST)
        best = None
        best_delta = 1e9
        for blk in candidates:
            delta = (rec_local - blk["src_local"]).total_seconds()
            if -2 <= delta <= 30 and abs(delta) < best_delta:
                best, best_delta = blk, abs(delta)
        if best is not None:
            rec["inference_ms"] = best["elapsed_ms"]
            matched += 1
    return matched, len(yumo_records)


# -------------------- 写库 + 拷文件 --------------------

def import_records(records: Iterable[dict], dry_run: bool = False) -> dict:
    db.init()  # 确保表 + model_name 列存在
    config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    inserted = 0
    skipped_dup = 0
    missing_audio = 0

    # 用 (created_at, audio_filename) 双键去重（已存在的不重复插）
    with sqlite3.connect(config.DB_PATH) as conn:
        existing = {
            (r[0], r[1])
            for r in conn.execute(
                "SELECT created_at, audio_filename FROM transcriptions"
            ).fetchall()
        }

    for rec in records:
        utc_iso = rec["created_at_utc"].strftime("%Y-%m-%dT%H:%M:%SZ")
        if (utc_iso, rec["audio_filename"]) in existing:
            skipped_dup += 1
            continue

        # 拷音频文件（按 created_at 日期，方案 A：保留原文件名）
        rel_path = None
        size = None
        if rec["audio_filename"]:
            src = rec["src_dir"] / rec["audio_filename"]
            if src.is_file():
                day = rec["created_at_utc"].astimezone(CST).strftime("%Y-%m-%d")
                dst_dir = config.RECORDINGS_DIR / day
                dst_dir.mkdir(parents=True, exist_ok=True)
                dst = dst_dir / rec["audio_filename"]
                if not dry_run and not dst.exists():
                    shutil.copy2(src, dst)
                size = src.stat().st_size
                rel_path = f"{day}/{rec['audio_filename']}"
            else:
                missing_audio += 1

        text_final = rec["text_final"]
        char_count = len(text_final) if text_final else 0
        keystroke = kstats.estimate_keystrokes(text_final)

        record = {
            "created_at": utc_iso,
            "audio_filename": rec["audio_filename"],
            "audio_path": rel_path,
            "audio_size": size,
            "audio_duration": rec["audio_duration"],
            "inference_ms": rec["inference_ms"],
            "text_raw": rec["text_raw"],
            "text_final": text_final,
            "char_count": char_count,
            "keystroke_count": keystroke,
            "client_ip": rec["client_ip"],
            "client_host": rec["client_host"],
            "model_name": rec["model_name"],
            "error": None,
        }
        if not dry_run:
            db.insert_transcription(record)
        inserted += 1

    return {"inserted": inserted, "skipped_dup": skipped_dup, "missing_audio": missing_audio}


# -------------------- main --------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印不写库不拷文件")
    ap.add_argument("--source", choices=["voiceink", "yumo", "all"], default="all")
    args = ap.parse_args()

    print("=== 解析 mac ASR 日志（用于补 yumo 推理耗时） ===")
    log_blocks = parse_asr_logs()
    print(f"  日志中有 {len(log_blocks)} 个完整请求块（leju 来源）")

    voiceink_recs = []
    yumo_recs = []

    if args.source in ("voiceink", "all"):
        voiceink_recs = list(iter_voiceink_records())
        print(f"\n=== mac VoiceInk: {len(voiceink_recs)} 条记录 ===")

    if args.source in ("yumo", "all"):
        yumo_recs = list(iter_yumo_records())
        print(f"\n=== leju Yumo: {len(yumo_recs)} 条记录 ===")
        matched, total = attach_inference_ms(yumo_recs, log_blocks)
        print(f"  推理耗时匹配: {matched}/{total} ({matched * 100 / total:.1f}%)")

    print(f"\n=== 写入 db (dry_run={args.dry_run}) ===")
    if voiceink_recs:
        res = import_records(voiceink_recs, dry_run=args.dry_run)
        print(f"  voiceink → 新增 {res['inserted']}, 重复跳过 {res['skipped_dup']}, 音频缺失 {res['missing_audio']}")
    if yumo_recs:
        res = import_records(yumo_recs, dry_run=args.dry_run)
        print(f"  yumo     → 新增 {res['inserted']}, 重复跳过 {res['skipped_dup']}, 音频缺失 {res['missing_audio']}")

    if not args.dry_run:
        # 简要统计
        with sqlite3.connect(config.DB_PATH) as conn:
            total = conn.execute("SELECT COUNT(*) FROM transcriptions").fetchone()[0]
            by_client = conn.execute(
                "SELECT client_host, COUNT(*), SUM(audio_duration), SUM(char_count)"
                " FROM transcriptions WHERE error IS NULL GROUP BY client_host"
            ).fetchall()
            with_inf = conn.execute(
                "SELECT COUNT(*) FROM transcriptions WHERE inference_ms IS NOT NULL"
            ).fetchone()[0]
        print(f"\n=== 当前 db 状态 ===")
        print(f"  总记录: {total}")
        print(f"  含推理耗时: {with_inf}")
        for host, n, dur, chars in by_client:
            print(f"  {host or '(null)'}: {n} 条, {(dur or 0)/60:.1f} 分钟, {chars or 0} 字")


if __name__ == "__main__":
    main()
