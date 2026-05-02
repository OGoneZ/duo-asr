#!/usr/bin/env python3
"""把 VoiceInk default.store 中"晚于 db 最大 created_at"的新转录补回 db。

数据来源：
  - VoiceInk store    Z_PK / ZTIMESTAMP / ZAUDIOFILEURL / ZTEXT / ZDURATION /
                      ZTRANSCRIPTIONDURATION / ZTRANSCRIPTIONMODELNAME
  - leju ASR 日志     migration/server-logs/leju/2026-*/*.log
                      用于补 text_raw（VoiceInk 的 ZTEXT 是 normalize 后）和
                      精确的 inference_ms（仅模型耗时）

匹配策略（优先级降序）：
  1. 日志「收到文件 X.wav」== VoiceInk basename(ZAUDIOFILEURL) → 精确锚点
     拿同一请求块的「原始输出」/「耗时」回填
  2. 文件名匹配不上 → text_raw 留空（=ZTEXT），inference_ms 用 VoiceInk 字段降级
"""
from __future__ import annotations

import argparse
import re
import shutil
import sqlite3
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import db  # noqa: E402
import stats as kstats  # noqa: E402

VOICEINK_STORE = Path("/Users/zhubaoduo/Library/Application Support/com.prakashjoshipax.VoiceInk/default.store")
VOICEINK_RECDIR = Path("/Users/zhubaoduo/Library/Application Support/com.prakashjoshipax.VoiceInk/Recordings")
LEJU_LOGS = ROOT / "migration/server-logs/leju"

APPLE_EPOCH = 978307200  # datetime(2001,1,1, tzinfo=utc).timestamp()

LOG_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) INFO (.*)$")
SRC_ANY = re.compile(r"请求来源[: ]")
RECV_FILE = re.compile(r"收到文件: (\S+?\.wav)")
RAW_NEW = re.compile(r"原始输出: (.*)$")
FINAL_NEW = re.compile(r"后处理后: (.*)$")
ELAPSED_NEW = re.compile(r"转写完成, 耗时: ([\d.]+)秒$")


def _normalize_model_name(name: str | None) -> str | None:
    if not name:
        return name
    if name in {"Qwen3-ASR", "Qwen3 ASR", "qwen3-asr", "Qwen3-ASR-1.7B"}:
        return "Qwen3-ASR-1.7B"
    return name


def parse_log_blocks() -> dict[str, dict]:
    """扫 leju 日志，返回 {filename: {raw, final, inference_ms, src_local}}"""
    blocks: dict[str, dict] = {}
    for log_file in sorted(LEJU_LOGS.rglob("*.log")):
        cur: dict | None = None
        for line in log_file.read_text(errors="ignore").splitlines():
            m = LOG_LINE.match(line)
            if not m:
                continue
            ts_str, msg = m.groups()
            local = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
            if SRC_ANY.search(msg):
                cur = {"src_local": local, "filename": None,
                       "raw": None, "final": None, "inference_ms": None}
            elif cur is not None:
                if (rm := RECV_FILE.search(msg)):
                    cur["filename"] = rm.group(1)
                elif (rm := RAW_NEW.search(msg)):
                    cur["raw"] = rm.group(1)
                elif (rm := FINAL_NEW.search(msg)):
                    cur["final"] = rm.group(1)
                elif (rm := ELAPSED_NEW.search(msg)):
                    cur["inference_ms"] = int(float(rm.group(1)) * 1000)
                    if cur["filename"]:
                        blocks[cur["filename"]] = cur
                    cur = None
    return blocks


def get_db_max_created_at() -> tuple[float, str]:
    """返回 (apple_time, iso) - db 中最大 created_at 对应的截止边界"""
    with sqlite3.connect(config.DB_PATH) as conn:
        # 用 macmini 客户端的最大值（避免 client=local 的测试 wav 干扰）
        row = conn.execute(
            "SELECT MAX(created_at) FROM transcriptions WHERE client_host = 'macmini'"
        ).fetchone()
    iso = row[0] if row and row[0] else "2001-01-01T00:00:00Z"
    dt = datetime.strptime(iso.rstrip("Z"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return dt.timestamp() - APPLE_EPOCH, iso


def iter_new_voiceink(after_apple_time: float):
    src = Path("/tmp/voiceink-now.db")
    # 用 .backup 拷出来读，不锁原 db
    sqlite3.connect(VOICEINK_STORE).backup(sqlite3.connect(src))
    conn = sqlite3.connect(src)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT Z_PK, ZTIMESTAMP, ZDURATION, ZTRANSCRIPTIONDURATION,
               ZAUDIOFILEURL, ZTEXT, ZENHANCEDTEXT,
               ZTRANSCRIPTIONMODELNAME
        FROM ZTRANSCRIPTION
        WHERE ZTIMESTAMP IS NOT NULL AND ZTIMESTAMP > ?
        ORDER BY ZTIMESTAMP
    """, (after_apple_time,)).fetchall()
    conn.close()
    for r in rows:
        url = r["ZAUDIOFILEURL"] or ""
        path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
        filename = Path(path).name if path else None
        utc_dt = datetime.fromtimestamp(APPLE_EPOCH + r["ZTIMESTAMP"], tz=timezone.utc)
        # ZTEXT = 服务返回的 final（已经过 normalize_numbers）
        final_text = r["ZENHANCEDTEXT"] or r["ZTEXT"]
        yield {
            "z_pk": r["Z_PK"],
            "created_at_utc": utc_dt,
            "audio_filename": filename,
            "audio_duration": r["ZDURATION"],
            "client_inference_ms": int((r["ZTRANSCRIPTIONDURATION"] or 0) * 1000) or None,
            "text_final": final_text,
            "model_name": _normalize_model_name(r["ZTRANSCRIPTIONMODELNAME"] or "VoiceInk"),
        }


def plan_imports(records: list[dict], log_blocks: dict[str, dict]) -> list[dict]:
    """合并 VoiceInk 字段 + leju 日志精确数据，返回最终待入库记录"""
    out = []
    for rec in records:
        fn = rec["audio_filename"]
        log = log_blocks.get(fn) if fn else None
        if log:
            text_raw = log["raw"]
            # 用服务端 log.final，而不是 ZTEXT —— ZTEXT 经过 VoiceInk 客户端
            # 二次加工（中英文加空格），会污染 raw/final 差异语义。
            # 我们 dashboard 反映的是"服务做了什么"，应同源比较。
            text_final = log["final"]
            inference_ms = log["inference_ms"] or rec["client_inference_ms"]
            matched = True
        else:
            text_raw = rec["text_final"]   # 降级：raw == final
            text_final = rec["text_final"]
            inference_ms = rec["client_inference_ms"]
            matched = False
        out.append({
            **rec,
            "text_raw": text_raw,
            "text_final": text_final,
            "inference_ms": inference_ms,
            "log_matched": matched,
        })
    return out


def already_in_db(filenames: list[str]) -> set[str]:
    if not filenames:
        return set()
    with sqlite3.connect(config.DB_PATH) as conn:
        placeholder = ",".join(["?"] * len(filenames))
        rows = conn.execute(
            f"SELECT audio_filename FROM transcriptions WHERE audio_filename IN ({placeholder})",
            filenames,
        ).fetchall()
    return {r[0] for r in rows}


def execute(plan: list[dict], dry_run: bool) -> dict:
    db.init()
    config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    existing = already_in_db([p["audio_filename"] for p in plan if p["audio_filename"]])
    inserted = skipped_dup = missing_audio = 0

    for p in plan:
        fn = p["audio_filename"]
        if fn and fn in existing:
            skipped_dup += 1
            continue

        rel_path = None
        size = None
        if fn:
            src = VOICEINK_RECDIR / fn
            if src.is_file():
                day = p["created_at_utc"].astimezone().strftime("%Y-%m-%d")
                dst_dir = config.RECORDINGS_DIR / day
                dst_dir.mkdir(parents=True, exist_ok=True)
                dst = dst_dir / fn
                if not dry_run and not dst.exists():
                    shutil.copy2(src, dst)
                size = src.stat().st_size
                rel_path = f"{day}/{fn}"
            else:
                missing_audio += 1

        text_final = p["text_final"]
        text_raw = p["text_raw"]
        char_count = len(text_final) if text_final else 0
        keystroke_count = kstats.estimate_keystrokes(text_final)
        post_processed = 1 if (text_raw and text_final and text_raw != text_final) else 0

        record = {
            "created_at": p["created_at_utc"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "audio_filename": fn,
            "audio_path": rel_path,
            "audio_size": size,
            "audio_duration": p["audio_duration"],
            "inference_ms": p["inference_ms"],
            "text_raw": text_raw,
            "text_final": text_final,
            "char_count": char_count,
            "keystroke_count": keystroke_count,
            "client_ip": None,
            "client_host": "macmini",
            "model_name": p["model_name"],
            "post_processed": post_processed,
            "error": None,
        }
        if not dry_run:
            db.insert_transcription(record)
        inserted += 1

    return {"inserted": inserted, "skipped_dup": skipped_dup, "missing_audio": missing_audio}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    print("=== 1. db 当前最大 created_at（macmini）===")
    boundary, iso = get_db_max_created_at()
    print(f"  {iso}  (apple_time={boundary:.0f})")

    print("\n=== 2. 解析 leju 日志（按文件名索引）===")
    log_blocks = parse_log_blocks()
    print(f"  找到 {len(log_blocks)} 个完整请求块（含 filename）")

    print("\n=== 3. 读 VoiceInk 新增记录 ===")
    voiceink_recs = list(iter_new_voiceink(boundary))
    print(f"  新增 {len(voiceink_recs)} 条")

    print("\n=== 4. 配对 ===")
    plan = plan_imports(voiceink_recs, log_blocks)
    matched = sum(1 for p in plan if p["log_matched"])
    pp_count = sum(1 for p in plan if p["text_raw"] and p["text_final"] and p["text_raw"] != p["text_final"])
    print(f"  配对成功: {matched}/{len(plan)} ({matched*100/max(len(plan),1):.1f}%)")
    print(f"  其中 raw != final（经过后处理）: {pp_count} 条")

    # 抽样审查 5 条
    print("\n=== 5. 抽样审查（含差异）===")
    diff_samples = [p for p in plan if p["log_matched"] and p["text_raw"] != p["text_final"]][:3]
    matched_samples = [p for p in plan if p["log_matched"] and p["text_raw"] == p["text_final"]][:2]
    for p in diff_samples + matched_samples:
        m = "✓" if p["log_matched"] else "✗"
        print(f"\n  pk={p['z_pk']} matched={m} infer={p['inference_ms'] or 0}ms")
        print(f"    file:  {p['audio_filename'][:40]}")
        print(f"    raw:   {(p['text_raw'] or '')[:80]}")
        print(f"    final: {(p['text_final'] or '')[:80]}")

    print(f"\n=== 6. {'apply' if args.apply else 'dry-run'} ===")
    res = execute(plan, dry_run=not args.apply)
    print(f"  新增写库: {res['inserted']}")
    print(f"  filename 重复跳过: {res['skipped_dup']}")
    print(f"  音频缺失（不在 VoiceInk Recordings/）: {res['missing_audio']}")

    if args.apply:
        with sqlite3.connect(config.DB_PATH) as conn:
            total = conn.execute("SELECT COUNT(*) FROM transcriptions").fetchone()[0]
            new_pp = conn.execute(
                "SELECT COUNT(*) FROM transcriptions WHERE post_processed = 1 "
                "AND created_at > ?", (iso,)
            ).fetchone()[0]
        print(f"\n  db 总记录: {total}")
        print(f"  新增中 post_processed=1 的: {new_pp}")


if __name__ == "__main__":
    main()
