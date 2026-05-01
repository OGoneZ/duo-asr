#!/usr/bin/env python3
"""回填 text_raw：从 mac ASR 日志中提取「原始输出 ≠ 后处理后」的对，
匹配到对应 db 记录并 UPDATE text_raw。

匹配规则：
  - 文本：log.final 与 db.text_final 去空格后完全相等
  - 时间：|db.created_at(UTC) - log.src(UTC)| <= 60 秒
  - 唯一性：同时匹配多条 db 记录 → 取时间差最小的；多个 log 候选打到同一 db → warn

只更新 raw != final 的候选（不动 raw == final 的多数记录）。
默认 dry-run，加 --apply 才真改 db。
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402

LOG_DIR = ROOT / "logs"
CST = timezone(timedelta(hours=8))
TIME_WINDOW_SEC = 60

LOG_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) INFO (.*)$")
SRC_ANY = re.compile(r"请求来源[: ]")
RAW_NEW = re.compile(r"原始输出: (.*)$")
FINAL_NEW = re.compile(r"后处理后: (.*)$")
ELAPSED_OLD = re.compile(r"转写完成, 耗时: ([\d.]+)秒, 结果: (.*)$")  # 老格式 raw 在这里


def _norm(s: str | None) -> str:
    return re.sub(r"\s+", "", s or "")


def parse_diff_blocks() -> list[dict]:
    """扫日志，返回 raw != final 的所有块。
    块字段：{src_utc, raw, final}
    """
    blocks: list[dict] = []
    for log_file in sorted(LOG_DIR.glob("*/*.log")):
        cur: dict | None = None
        prev_line: str | None = None
        for line in log_file.read_text(errors="ignore").splitlines():
            if line == prev_line:
                continue  # dedup logger 重复
            prev_line = line
            m = LOG_LINE.match(line)
            if not m:
                continue
            ts_str, msg = m.groups()
            local_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)
            if SRC_ANY.search(msg):
                cur = {"src_utc": local_dt.astimezone(timezone.utc),
                       "raw": None, "final": None}
            elif cur is not None and (rm := RAW_NEW.search(msg)):
                cur["raw"] = rm.group(1)
            elif cur is not None and (fm := FINAL_NEW.search(msg)):
                cur["final"] = fm.group(1)
                if cur["raw"] is not None and cur["raw"] != cur["final"]:
                    blocks.append(cur)
                cur = None
            elif cur is not None and (em := ELAPSED_OLD.search(msg)):
                # 老格式：raw 嵌在 elapsed 行里。老日志没拆 raw / final，跳过
                cur = None
    return blocks


def load_db_records() -> list[dict]:
    """读取所有 db 记录的 (id, created_at_utc, text_final, text_raw)。"""
    conn = sqlite3.connect(config.DB_PATH)
    rows = conn.execute("""
        SELECT id, created_at, text_final, text_raw
        FROM transcriptions
        WHERE text_final IS NOT NULL
    """).fetchall()
    conn.close()
    out = []
    for rid, ts_iso, final, raw in rows:
        try:
            dt = datetime.strptime(ts_iso.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S")
            dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        out.append({"id": rid, "ts_utc": dt, "final": final, "raw": raw})
    return out


def match_and_plan(blocks: list[dict], records: list[dict]) -> tuple[list[dict], dict]:
    """规划更新：返回 (updates, stats)
    updates: [{db_id, old_raw, new_raw, final, time_delta_sec}]
    stats: 各种计数
    """
    by_final: dict[str, list[dict]] = {}
    for r in records:
        by_final.setdefault(_norm(r["final"]), []).append(r)

    updates: list[dict] = []
    no_match = 0
    multi_match_used_nearest = 0
    already_correct = 0

    for blk in blocks:
        candidates = by_final.get(_norm(blk["final"]), [])
        if not candidates:
            no_match += 1
            continue
        in_window = [
            (abs((r["ts_utc"] - blk["src_utc"]).total_seconds()), r)
            for r in candidates
            if abs((r["ts_utc"] - blk["src_utc"]).total_seconds()) <= TIME_WINDOW_SEC
        ]
        if not in_window:
            no_match += 1
            continue
        if len(in_window) > 1:
            multi_match_used_nearest += 1
        delta, best = min(in_window, key=lambda x: x[0])

        if best["raw"] == blk["raw"]:
            already_correct += 1
            continue

        updates.append({
            "db_id": best["id"],
            "old_raw": best["raw"],
            "new_raw": blk["raw"],
            "final": blk["final"],
            "delta_sec": delta,
        })

    stats = {
        "blocks_total": len(blocks),
        "no_match": no_match,
        "multi_match_used_nearest": multi_match_used_nearest,
        "already_correct": already_correct,
        "to_update": len(updates),
    }
    return updates, stats


def detect_collisions(updates: list[dict]) -> list[int]:
    seen: dict[int, list[dict]] = {}
    for u in updates:
        seen.setdefault(u["db_id"], []).append(u)
    return [db_id for db_id, ups in seen.items() if len(ups) > 1]


def apply_updates(updates: list[dict]) -> int:
    conn = sqlite3.connect(config.DB_PATH)
    cur = conn.cursor()
    n = 0
    for u in updates:
        cur.execute(
            "UPDATE transcriptions SET text_raw = ? WHERE id = ?",
            (u["new_raw"], u["db_id"]),
        )
        n += cur.rowcount
    conn.commit()
    conn.close()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="不加默认 dry-run")
    args = ap.parse_args()

    print("=== 1. 解析日志中 raw != final 的块 ===")
    blocks = parse_diff_blocks()
    print(f"  找到 {len(blocks)} 个差异块")

    print("\n=== 2. 加载 db 记录 ===")
    records = load_db_records()
    print(f"  共 {len(records)} 条")

    print("\n=== 3. 匹配 & 规划 ===")
    updates, stats = match_and_plan(blocks, records)
    print(f"  日志差异块总数: {stats['blocks_total']}")
    print(f"  匹配不到 db 的: {stats['no_match']}")
    print(f"  时间窗内有多个候选（取最近）: {stats['multi_match_used_nearest']}")
    print(f"  db raw 已经正确（跳过）: {stats['already_correct']}")
    print(f"  → 计划 UPDATE: {stats['to_update']}")

    print("\n=== 4. 冲突检测：同一个 db_id 被多个 log 打中 ===")
    collisions = detect_collisions(updates)
    if collisions:
        print(f"  ⚠️  {len(collisions)} 个 db 记录有多个 log 块争抢")
        for db_id in collisions[:10]:
            same = [u for u in updates if u["db_id"] == db_id]
            print(f"    db_id={db_id}, 候选 raw 们：")
            for u in same:
                print(f"      Δ={u['delta_sec']:.0f}s  raw={u['new_raw'][:60]}")
    else:
        print("  无冲突")

    print("\n=== 5. 抽样审查（前 5 条计划更新） ===")
    for u in updates[:5]:
        print(f"  id={u['db_id']}  Δ={u['delta_sec']:.0f}s")
        print(f"    final = {u['final'][:80]}")
        print(f"    old_raw  = {u['old_raw'][:80]}")
        print(f"    new_raw  = {u['new_raw'][:80]}")
        print()

    if args.apply:
        print("\n=== 6. 应用更新到 db ===")
        n = apply_updates(updates)
        print(f"  实际写入 {n} 条")
    else:
        print("\n=== 6. dry-run（未写库），加 --apply 真正执行 ===")


if __name__ == "__main__":
    main()
