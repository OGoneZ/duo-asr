from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import asyncio
import socket
import tempfile
import os
import time

import config
from errors import ASRServerError, ModelLoadError
from logger import setup_logger
import model

logger = setup_logger(__name__)

_PTR_CACHE_TTL_SECONDS = 300
_ptr_cache: dict[str, tuple[str, float]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 服务启动时预加载模型，避免首条语音请求触发冷启动。
    logger.info("服务启动中，开始预加载模型")
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
    # 依赖系统 resolver —— macmini 上 WG 已把 DNS 指到 10.0.0.1（CoreDNS）。
    # 失败一律回落到 IP 本身，不影响业务。
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
    # 名单仍用数字 IP 判定，避免 XFF 被伪造绕过
    if not _is_allowed_client_ip(client_ip):
        logger.warning(f"拒绝非授权网段访问: {client_ip}")
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    client_label = _format_client(await _resolve_peer_name(client_ip), client_ip)
    logger.info(f"请求来源: {client_label}")
    return await call_next(request)


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    start_time = time.time()
    tmp_path = None

    try:
        audio_bytes = await file.read()
        size = len(audio_bytes)
        size_str = f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.1f} KB"
        logger.info(f"收到文件: {file.filename}, 大小: {size_str}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        text = model.transcribe(tmp_path)
        elapsed = time.time() - start_time
        logger.info(f"转写完成, 耗时: {elapsed:.2f}秒")
        return JSONResponse({"text": text})
    except Exception:
        logger.exception("转写请求失败: filename=%s", file.filename)
        raise
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                logger.exception("删除临时文件失败: %s", tmp_path)


@app.get("/health")
async def health():
    return {"status": "ok"}
