from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import JSONResponse
import tempfile
import os
import time

from logger import setup_logger
import model

logger = setup_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 服务启动时预加载模型，避免首条语音请求触发冷启动。
    model.load_model()
    yield


app = FastAPI(lifespan=lifespan)

# 只允许 66.66.66.0/24 网段和本地访问
@app.middleware("http")
async def restrict_ip(request: Request, call_next):
    client_ip = request.client.host
    logger.info(f"请求来源 IP: {client_ip}")
    allowed = client_ip == "127.0.0.1" or client_ip == "::1" or client_ip.startswith("66.66.66.")
    if not allowed:
        logger.warning(f"拒绝非授权网段访问: {client_ip}")
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    return await call_next(request)


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    start_time = time.time()
    audio_bytes = await file.read()
    size = len(audio_bytes)
    size_str = f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.1f} KB"
    logger.info(f"收到文件: {file.filename}, 大小: {size_str}")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        text = model.transcribe(tmp_path)
        elapsed = time.time() - start_time
        logger.info(f"转写完成, 耗时: {elapsed:.2f}秒")
        return JSONResponse({"text": text})
    finally:
        os.unlink(tmp_path)


@app.get("/health")
async def health():
    return {"status": "ok"}
