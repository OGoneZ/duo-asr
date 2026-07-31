"""SQLite 持久化：转录记录的写入与查询。"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Any

from app import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS transcriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT    NOT NULL,
    audio_filename  TEXT,
    audio_path      TEXT,
    audio_size      INTEGER,
    audio_duration  REAL,
    inference_ms    INTEGER,
    postprocess_ms  INTEGER DEFAULT 0,
    text_raw        TEXT,
    text_final      TEXT,
    char_count      INTEGER,
    keystroke_count INTEGER,
    client_ip       TEXT,
    client_host     TEXT,
    model_name      TEXT,
    post_model_name TEXT,
    post_processed  INTEGER DEFAULT 0,
    error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_created_at ON transcriptions(created_at DESC);
"""

_lock = threading.Lock()


def init() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(_SCHEMA)
        # 幂等迁移：旧 db 缺列时补加
        existing = {
            r["name"] for r in conn.execute("PRAGMA table_info(transcriptions)")
        }
        if "model_name" not in existing:
            conn.execute("ALTER TABLE transcriptions ADD COLUMN model_name TEXT")
        if "post_model_name" not in existing:
            conn.execute("ALTER TABLE transcriptions ADD COLUMN post_model_name TEXT")
        if "post_processed" not in existing:
            conn.execute(
                "ALTER TABLE transcriptions ADD COLUMN post_processed INTEGER DEFAULT 0"
            )
            conn.execute("""
                UPDATE transcriptions
                SET post_processed = CASE
                    WHEN text_raw IS NOT NULL
                     AND text_final IS NOT NULL
                     AND text_raw != text_final THEN 1
                    ELSE 0
                END
            """)
        if "postprocess_ms" not in existing:
            conn.execute(
                "ALTER TABLE transcriptions ADD COLUMN postprocess_ms INTEGER DEFAULT 0"
            )


@contextmanager
def _connect():
    conn = sqlite3.connect(config.DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
    finally:
        conn.close()


def insert_transcription(record: dict[str, Any]) -> int:
    cols = ", ".join(record.keys())
    placeholders = ", ".join(f":{k}" for k in record.keys())
    sql = f"INSERT INTO transcriptions ({cols}) VALUES ({placeholders})"
    with _lock, _connect() as conn:
        cur = conn.execute(sql, record)
        return cur.lastrowid


def get_by_id(rec_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM transcriptions WHERE id = ?", (rec_id,)
        ).fetchone()
    return dict(row) if row else None


def _client_filter(client: str | None) -> tuple[str, list]:
    """生成 'AND client_host = ?' 片段；client 为 None / 'all' 时返回空过滤。"""
    if not client or client == "all":
        return "", []
    return "AND client_host = ?", [client]


def query_summary(client: str | None = None, days: int | None = None) -> dict:
    """累计统计：总记录、总字数、总击键、总时长。仅成功条目计入正向统计。
    days  非空时只统计最近 N 天的记录。
    """
    conds: list[str] = []
    params: list = []
    if client and client != "all":
        conds.append("client_host = ?")
        params.append(client)
    if days and days > 0:
        conds.append("created_at >= datetime('now', ?)")
        params.append(f"-{days} days")
    extra = (" AND " + " AND ".join(conds)) if conds else ""

    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT
                COUNT(*)                            AS total_count,
                COALESCE(SUM(char_count), 0)        AS total_chars,
                COALESCE(SUM(keystroke_count), 0)   AS total_keystrokes,
                COALESCE(SUM(audio_duration), 0)    AS total_duration_sec,
                COALESCE(AVG(inference_ms), 0)      AS avg_inference_ms,
                COALESCE(
                    AVG(CASE WHEN postprocess_ms > 0 THEN postprocess_ms END), 0
                )                                   AS avg_postprocess_ms,
                MIN(created_at)                     AS first_at,
                MAX(created_at)                     AS last_at
            FROM transcriptions
            WHERE error IS NULL {extra}
            """,
            params,
        ).fetchone()
        err_count = conn.execute(
            f"SELECT COUNT(*) AS c FROM transcriptions WHERE error IS NOT NULL {extra}",
            params,
        ).fetchone()["c"]
    out = dict(row)
    out["error_count"] = err_count

    # 全局首次使用时间（不受 days 过滤限制，仅按 client 区分），
    # 用于前端计算"已使用 N 天"。
    global_conds = ["error IS NULL"]
    global_params: list = []
    if client and client != "all":
        global_conds.append("client_host = ?")
        global_params.append(client)
    with _connect() as conn:
        first_row = conn.execute(
            f"SELECT MIN(created_at) AS first_used_at FROM transcriptions WHERE {' AND '.join(global_conds)}",
            global_params,
        ).fetchone()
    out["first_used_at"] = first_row["first_used_at"]
    return out


def query_daily(days: int, client: str | None = None) -> list[dict]:
    """近 N 天每日聚合（按本地日期）。"""
    flt, params = _client_filter(client)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT
                DATE(created_at, 'localtime')           AS day,
                COUNT(*)                                AS count,
                COALESCE(SUM(char_count), 0)            AS chars,
                COALESCE(SUM(keystroke_count), 0)       AS keystrokes,
                COALESCE(SUM(audio_duration), 0)        AS duration_sec
            FROM transcriptions
            WHERE error IS NULL
              AND created_at >= datetime('now', ?)
              {flt}
            GROUP BY day
            ORDER BY day
            """,
            [f"-{days} days", *params],
        ).fetchall()
    return [dict(r) for r in rows]


def query_clients() -> list[str]:
    """已知出现过的客户端列表（按近期活跃度排序）。"""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT client_host AS client, MAX(created_at) AS last
            FROM transcriptions
            WHERE error IS NULL AND client_host IS NOT NULL
            GROUP BY client_host
            ORDER BY last DESC
            """
        ).fetchall()
    return [r["client"] for r in rows]


def query_recent(
    limit: int,
    offset: int = 0,
    q: str | None = None,
    client: str | None = None,
    since: str | None = None,
    until: str | None = None,
    post_processed: int | None = None,
) -> list[dict]:
    """最近转录列表。所有过滤条件 AND 关系。
    q              文本模糊（匹配 text_final 或 text_raw）
    client         按 client_host 过滤
    since / until  本地日期 YYYY-MM-DD（包含端点）
    post_processed 0/1，1=只看经过后处理的
    """
    conds: list[str] = []
    params: list = []
    if q:
        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{esc}%"
        conds.append("(text_final LIKE ? ESCAPE '\\' OR text_raw LIKE ? ESCAPE '\\')")
        params += [like, like]
    if client and client != "all":
        conds.append("client_host = ?")
        params.append(client)
    if since:
        conds.append("DATE(created_at, 'localtime') >= ?")
        params.append(since)
    if until:
        conds.append("DATE(created_at, 'localtime') <= ?")
        params.append(until)
    if post_processed in (0, 1):
        conds.append("post_processed = ?")
        params.append(post_processed)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""

    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT id, created_at, audio_duration, inference_ms, postprocess_ms,
                   text_raw, text_final, char_count, keystroke_count,
                   client_host, client_ip, model_name, post_model_name, post_processed, error
            FROM transcriptions
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    return [dict(r) for r in rows]


def query_by_client(days: int) -> list[dict]:
    """按 client_host 聚合最近 N 天的成功转录。"""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT
                COALESCE(client_host, '(unknown)')      AS client,
                COUNT(*)                                AS count,
                COALESCE(SUM(char_count), 0)            AS chars,
                COALESCE(SUM(keystroke_count), 0)       AS keystrokes,
                COALESCE(SUM(audio_duration), 0)        AS duration_sec
            FROM transcriptions
            WHERE error IS NULL
              AND created_at >= datetime('now', ?)
            GROUP BY client
            ORDER BY chars DESC
            """,
            (f"-{days} days",),
        ).fetchall()
    return [dict(r) for r in rows]
