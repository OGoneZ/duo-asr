from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import JSONResponse
import torch
from qwen_asr import Qwen3ASRModel
import tempfile
import os
import time

from logger import setup_logger

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

MODEL_PATH = Path(__file__).parent / "models" / "Qwen3-ASR-1.7B"

logger.info(f"正在加载模型: {MODEL_PATH}")
model = Qwen3ASRModel.from_pretrained(
    str(MODEL_PATH),
    dtype=torch.bfloat16,
    device_map="auto"
)
logger.info("模型加载完成!")

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
        results = model.transcribe(tmp_path, language=None)
        transcription = results[0].text
        elapsed = time.time() - start_time
        logger.info(f"转写完成, 耗时: {elapsed:.2f}秒, 结果: {transcription}")
        return JSONResponse({"text": transcription})
    finally:
        os.unlink(tmp_path)

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=9999,
        access_log=False
    )
