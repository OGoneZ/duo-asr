"""HTTP 路由：转写主接口 + 仪表盘统计 API。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import time
import uuid

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
import soundfile as sf

from app import config, db, model, stats
from app.logger import setup_logger

logger = setup_logger(__name__)

router = APIRouter()


def _archive_audio(audio_bytes: bytes, suffix: str = ".wav") -> tuple[Path, str]:
    """归档原始音频。返回 (绝对路径, 数据库存的相对路径)。"""
    today = datetime.now().strftime("%Y-%m-%d")
    day_dir = config.RECORDINGS_DIR / today
    day_dir.mkdir(parents=True, exist_ok=True)
    rec_id = uuid.uuid4().hex
    rel_path = f"{today}/{rec_id}{suffix}"
    abs_path = config.RECORDINGS_DIR / rel_path
    abs_path.write_bytes(audio_bytes)
    return abs_path, rel_path


def _audio_duration(path: Path) -> float | None:
    try:
        return float(sf.info(str(path)).duration)
    except Exception:
        logger.warning("无法读取音频时长: %s", path)
        return None


@router.post("/v1/audio/transcriptions")
async def transcribe(request: Request, file: UploadFile = File(...)):
    audio_bytes = await file.read()
    size = len(audio_bytes)
    size_str = f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.1f} KB"
    logger.info(f"收到文件: {file.filename}, 大小: {size_str}")

    suffix = Path(file.filename or "").suffix or ".wav"
    abs_path, rel_path = _archive_audio(audio_bytes, suffix=suffix)
    duration = _audio_duration(abs_path)

    record_base = {
        # 存 UTC ISO（带 Z），SQLite 用 datetime(..., 'localtime') 正确转本地时区
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio_filename": file.filename,
        "audio_path": rel_path,
        "audio_size": size,
        "audio_duration": duration,
        "client_ip": getattr(request.state, "client_ip", None),
        "client_host": getattr(request.state, "client_host", None),
        "model_name": config.MODEL_NAME,
    }

    start_time = time.time()
    try:
        result = model.transcribe(str(abs_path))
    except Exception as exc:
        elapsed = time.time() - start_time
        logger.exception("转写请求失败: filename=%s", file.filename)
        db.insert_transcription({
            **record_base,
            "inference_ms": int(elapsed * 1000),
            "text_raw": None,
            "text_final": None,
            "char_count": 0,
            "keystroke_count": 0,
            "error": str(exc),
        })
        raise

    elapsed = time.time() - start_time
    logger.info(f"转写完成, 耗时: {elapsed:.2f}秒")

    char_count = len(result.final) if result.final else 0
    keystroke_count = stats.estimate_keystrokes(result.final)
    post_processed = 1 if (result.raw and result.final and result.raw != result.final) else 0
    db.insert_transcription({
        **record_base,
        "inference_ms": result.inference_ms,
        "text_raw": result.raw,
        "text_final": result.final,
        "char_count": char_count,
        "keystroke_count": keystroke_count,
        "post_processed": post_processed,
        "error": None,
    })

    return JSONResponse({"text": result.final})


# ---------- Dashboard 与统计 API ----------

@router.get("/")
async def root_redirect():
    return RedirectResponse(url="/dashboard/")


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/api/stats/summary")
async def stats_summary(
    client: str | None = Query(None),
    days: int | None = Query(None, ge=1, le=3650),
):
    s = db.query_summary(client, days=days)
    duration = s.get("total_duration_sec") or 0
    chars = s.get("total_chars") or 0
    count = s.get("total_count") or 0
    s["chars_per_minute"] = round(chars * 60 / duration, 1) if duration > 0 else 0
    s["avg_duration_sec"] = round(duration / count, 1) if count > 0 else 0
    return s


@router.get("/api/stats/daily")
async def stats_daily(
    days: int = Query(30, ge=1, le=365),
    client: str | None = Query(None),
):
    return db.query_daily(days, client)


@router.get("/api/stats/clients")
async def stats_clients():
    return db.query_clients()


@router.get("/api/stats/by-client")
async def stats_by_client(days: int = Query(30, ge=1, le=365)):
    return db.query_by_client(days)


@router.get("/api/stats/recent")
async def stats_recent(
    n: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None),
    client: str | None = Query(None),
    since: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    until: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    post_processed: int | None = Query(None, ge=0, le=1),
):
    return db.query_recent(
        n, offset, q=q, client=client,
        since=since, until=until, post_processed=post_processed,
    )


@router.get("/api/recordings/{rec_id}")
async def recording_detail(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec:
        raise HTTPException(404, "not found")
    return rec


@router.get("/api/recordings/{rec_id}/audio")
async def recording_audio(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec or not rec.get("audio_path"):
        raise HTTPException(404, "audio not found")
    abs_path = config.RECORDINGS_DIR / rec["audio_path"]
    if not abs_path.is_file():
        raise HTTPException(410, "audio file removed")
    return FileResponse(abs_path, media_type="audio/wav", filename=abs_path.name)
