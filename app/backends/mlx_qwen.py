"""MLX-quantized Qwen3-ASR backend，封装 mlx-qwen3-asr。

检测条件：config.json 中有 ``quantization`` 字段且含 ``mode``（affine），
但没有 ``quant_method``（非 HuggingFace GPTQ/AWQ 量化）。
"""
from __future__ import annotations

import gc
import json
import time
from pathlib import Path

import mlx.core as mx
from mlx_qwen3_asr import Session

from app.backends.base import BackendError
from app.logger import setup_logger

logger = setup_logger(__name__)


class MlxAsrBackend:
    name = "mlx-qwen3-asr"

    def __init__(self, model_path: Path, device: str, dtype) -> None:
        self.model_path = model_path
        self.device = device
        self.dtype = dtype
        self._session: Session | None = None

    @classmethod
    def can_handle(cls, model_path: Path) -> bool:
        cfg = model_path / "config.json"
        if not cfg.is_file():
            return False
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
        except Exception:
            return False

        archs = data.get("architectures") or []
        if not isinstance(archs, list):
            return False
        if not any("Qwen3ASR" in str(a) for a in archs):
            return False

        quant = data.get("quantization") or {}
        if not quant:
            return False
        if "quant_method" in quant:
            return False
        return "mode" in quant and "bits" in quant

    def load(self) -> None:
        if self._session is not None:
            return
        logger.info(
            "MLX-Qwen3-ASR 加载: %s (device=%s)",
            self.model_path, self.device,
        )
        try:
            self._session = Session(model=str(self.model_path))
        except Exception as exc:
            raise BackendError(f"MLX-Qwen3-ASR 加载失败: {self.model_path}") from exc
        logger.info("MLX-Qwen3-ASR 加载完成")

    def transcribe(self, audio_path: str) -> tuple[str, int]:
        if self._session is None:
            raise BackendError("MLX backend 未加载")
        t0 = time.perf_counter()
        try:
            with mx.stream(mx.gpu):
                result = self._session.transcribe(audio_path)
        except Exception as exc:
            raise BackendError(f"MLX-Qwen3-ASR 推理失败: {audio_path}") from exc
        ms = int((time.perf_counter() - t0) * 1000)
        text = result.text
        if not text:
            raise BackendError(f"MLX-Qwen3-ASR 推理返回空结果: {audio_path}")
        return text, ms

    def unload(self) -> None:
        old = self._session
        self._session = None
        del old
        gc.collect()
        try:
            mx.clear_cache()
        except Exception:
            pass
