from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import JSONResponse
import tempfile
import os
import time

from logger import setup_logger
import service

logger = setup_logger(__name__)

app = FastAPI()

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
    logger.info(f"收到文件: {file.filename}, 大小: {len(audio_bytes)} 字节")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        logger.info("开始转写...")
        text = service.transcribe(tmp_path)
        elapsed = time.time() - start_time
        logger.info(f"转写完成, 耗时: {elapsed:.2f}秒, 结果: {text}")
        return JSONResponse({"text": text})
    finally:
        os.unlink(tmp_path)


@app.get("/health")
async def health():
    return {"status": "ok"}
