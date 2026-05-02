"""Qwen3-ASR 系列 backend，封装 qwen_asr.Qwen3ASRModel。"""
from __future__ import annotations

import gc
import json
import time
from pathlib import Path

import torch
from qwen_asr import Qwen3ASRModel

from app.backends.base import BackendError
from app.logger import setup_logger

logger = setup_logger(__name__)


class QwenAsrBackend:
    name = "qwen-asr"

    def __init__(self, model_path: Path, device: str, dtype) -> None:
        self.model_path = model_path
        self.device = device
        self.dtype = dtype
        self._model = None

    @classmethod
    def can_handle(cls, model_path: Path) -> bool:
        """看 config.json 的 architectures 字段是否含 Qwen3 ASR 字样。"""
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
        return any("Qwen3ASR" in str(a) or "Qwen3-ASR" in str(a) for a in archs)

    def load(self) -> None:
        if self._model is not None:
            return
        logger.info(
            "Qwen3-ASR 加载: %s (device=%s, dtype=%s)",
            self.model_path, self.device, self.dtype,
        )
        try:
            self._model = Qwen3ASRModel.from_pretrained(
                str(self.model_path),
                dtype=self.dtype,
                device_map={"": self.device},
            )
        except Exception as exc:
            raise BackendError(f"Qwen3-ASR 加载失败: {self.model_path}") from exc
        logger.info("Qwen3-ASR 加载完成")

    def transcribe(self, audio_path: str) -> tuple[str, int]:
        if self._model is None:
            raise BackendError("backend 未加载")
        t0 = time.perf_counter()
        try:
            results = self._model.transcribe(audio_path, language=None)
        except Exception as exc:
            raise BackendError(f"Qwen3-ASR 推理失败: {audio_path}") from exc
        ms = int((time.perf_counter() - t0) * 1000)
        if not results or not getattr(results[0], "text", None):
            raise BackendError(f"Qwen3-ASR 推理返回空结果: {audio_path}")
        return results[0].text, ms

    def unload(self) -> None:
        old = self._model
        self._model = None
        del old
        gc.collect()
        if torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:
                logger.warning("torch.cuda.empty_cache 失败", exc_info=True)
