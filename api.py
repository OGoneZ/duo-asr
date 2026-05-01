from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import asyncio
import socket
import time
import uuid

from fastapi import FastAPI, HTTPException, UploadFile, File, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import soundfile as sf

import config
import db
import model
import stats
from errors import ASRServerError, ModelLoadError
from logger import setup_logger

logger = setup_logger(__name__)

_PTR_CACHE_TTL_SECONDS = 300
_ptr_cache: dict[str, tuple[str, float]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 服务启动时初始化数据库 + 预加载模型，避免首条语音请求触发冷启动。
    logger.info("服务启动中，初始化数据库")
    db.init()
    config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    logger.info("预加载模型")
    try:
        model.load_model()
    except Exception:
        logger.exception("服务启动失败，模型预加载异常")
        raise
    logger.info("服务启动完成")
    try:
        yield
    finally:
        logger.info("服务正在关闭")


app = FastAPI(lifespan=lifespan)

# 静态资源（dashboard）— 仅在目录存在时挂载，避免冷启动报错
if config.STATIC_DIR.exists():
    app.mount(
        "/dashboard",
        StaticFiles(directory=str(config.STATIC_DIR / "dashboard"), html=True),
        name="dashboard",
    )


def _request_label(request: Request) -> str:
    return f"{request.method} {request.url.path}"


def _is_allowed_client_ip(client_ip: str) -> bool:
    if client_ip in config.ALLOWED_IPS:
        return True
    return any(client_ip.startswith(prefix) for prefix in config.ALLOWED_IP_PREFIXES)


def _get_real_client_ip(request: Request) -> str:
    # 走 Caddy 反代时 request.client.host 是 Caddy 的 10.0.0.1，
    # 真正的 peer IP 在 X-Forwarded-For 里（Caddy 默认会加）。
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host


async def _resolve_peer_name(ip: str) -> str:
    if ip in {"127.0.0.1", "::1"}:
        return "local"
    now = time.time()
    cached = _ptr_cache.get(ip)
    if cached and cached[1] > now:
        return cached[0]
    try:
        host, _, _ = await asyncio.to_thread(socket.gethostbyaddr, ip)
        name = host.removesuffix(".").removesuffix(".wg") or ip
    except (OSError, socket.herror):
        name = ip
    _ptr_cache[ip] = (name, now + _PTR_CACHE_TTL_SECONDS)
    return name


def _format_client(name: str, ip: str) -> str:
    return ip if name == ip else f"{name} ({ip})"


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


@app.exception_handler(ASRServerError)
async def handle_service_error(request: Request, exc: ASRServerError):
    status_code = 503 if isinstance(exc, ModelLoadError) else 500
    return JSONResponse({"error": str(exc)}, status_code=status_code)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError):
    logger.warning("请求参数校验失败: %s, errors=%s", _request_label(request), exc.errors())
    return JSONResponse({"error": "Invalid request", "details": exc.errors()}, status_code=422)


@app.exception_handler(HTTPException)
async def handle_http_error(request: Request, exc: HTTPException):
    log_method = logger.warning if exc.status_code < 500 else logger.error
    log_method("HTTP异常: %s, status=%s, detail=%s", _request_label(request), exc.status_code, exc.detail)
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception):
    logger.exception("未处理异常: %s", _request_label(request))
    return JSONResponse({"error": "Internal server error"}, status_code=500)


# 只允许 10.0.0.0/24 网段和本地访问
@app.middleware("http")
async def restrict_ip(request: Request, call_next):
    client_ip = _get_real_client_ip(request)
    if not _is_allowed_client_ip(client_ip):
        logger.warning(f"拒绝非授权网段访问: {client_ip}")
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    client_host = await _resolve_peer_name(client_ip)
    request.state.client_ip = client_ip
    request.state.client_host = client_host
    logger.info(f"请求来源: {_format_client(client_host, client_ip)}")
    return await call_next(request)


@app.post("/v1/audio/transcriptions")
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
    db.insert_transcription({
        **record_base,
        "inference_ms": result.inference_ms,
        "text_raw": result.raw,
        "text_final": result.final,
        "char_count": char_count,
        "keystroke_count": keystroke_count,
        "error": None,
    })

    return JSONResponse({"text": result.final})


# ---------- Dashboard 与统计 API ----------

@app.get("/")
async def root_redirect():
    return RedirectResponse(url="/dashboard/")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/stats/summary")
async def stats_summary(client: str | None = Query(None)):
    s = db.query_summary(client)
    duration = s.get("total_duration_sec") or 0
    chars = s.get("total_chars") or 0
    count = s.get("total_count") or 0
    s["chars_per_minute"] = round(chars * 60 / duration, 1) if duration > 0 else 0
    s["avg_duration_sec"] = round(duration / count, 1) if count > 0 else 0
    return s


@app.get("/api/stats/daily")
async def stats_daily(
    days: int = Query(30, ge=1, le=365),
    client: str | None = Query(None),
):
    return db.query_daily(days, client)


@app.get("/api/stats/clients")
async def stats_clients():
    return db.query_clients()


@app.get("/api/stats/by-client")
async def stats_by_client(days: int = Query(30, ge=1, le=365)):
    return db.query_by_client(days)


@app.get("/api/stats/recent")
async def stats_recent(
    n: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None),
    client: str | None = Query(None),
    since_days: int | None = Query(None, ge=1, le=3650),
):
    return db.query_recent(n, offset, q=q, client=client, since_days=since_days)


@app.get("/api/recordings/{rec_id}")
async def recording_detail(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec:
        raise HTTPException(404, "not found")
    return rec


@app.get("/api/recordings/{rec_id}/audio")
async def recording_audio(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec or not rec.get("audio_path"):
        raise HTTPException(404, "audio not found")
    abs_path = config.RECORDINGS_DIR / rec["audio_path"]
    if not abs_path.is_file():
        raise HTTPException(410, "audio file removed")
    return FileResponse(abs_path, media_type="audio/wav", filename=abs_path.name)
