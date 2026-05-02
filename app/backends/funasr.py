"""FunASR 系列 backend：覆盖 SenseVoice / Paraformer / Whisper-via-funasr 等。

ModelScope 上大量 ASR 模型用 funasr 框架打包，目录里通常有：
  - configuration.json（modelscope 元数据）
  - config.yaml      （funasr 模型配置）
  - model.pt / model.pth / *.bin
"""
from __future__ import annotations

import gc
import json
import re
import time
from pathlib import Path

import torch

from app.backends.base import BackendError
from app.logger import setup_logger

logger = setup_logger(__name__)


class FunAsrBackend:
    name = "funasr"

    def __init__(self, model_path: Path, device: str, dtype) -> None:
        self.model_path = model_path
        self.device = device
        self.dtype = dtype       # funasr 不直接接受 dtype，留作记录
        self._model = None

    @classmethod
    def can_handle(cls, model_path: Path) -> bool:
        """funasr 模型识别条件（任一满足即可）：
          1. configuration.json 里 framework=pytorch 且 task 含 asr / speech
          2. 同级有 config.yaml + model.pt（funasr 标准布局）
          3. 不能让 Qwen3 模型走到这里 — Qwen 由 QwenAsrBackend 优先匹配，
             所以这里宽松一些没关系。
        """
        cfg_yaml = model_path / "config.yaml"
        model_pt = model_path / "model.pt"
        if cfg_yaml.is_file() and (model_pt.is_file() or any(model_path.glob("model.*"))):
            return True

        modelscope_cfg = model_path / "configuration.json"
        if modelscope_cfg.is_file():
            try:
                data = json.loads(modelscope_cfg.read_text(encoding="utf-8"))
            except Exception:
                return False
            framework = (data.get("framework") or "").lower()
            task = (data.get("task") or "").lower()
            return framework == "pytorch" and ("asr" in task or "speech" in task)

        return False

    def load(self) -> None:
        if self._model is not None:
            return
        from funasr import AutoModel  # 延迟导入：funasr 启动有副作用 + 加载慢

        logger.info("FunASR 加载: %s (device=%s)", self.model_path, self.device)
        try:
            self._model = AutoModel(
                model=str(self.model_path),
                device=self.device,
                disable_update=True,    # 不要弹"检查更新"提示
                trust_remote_code=False,
            )
        except AssertionError as exc:
            # funasr 内部用 assert 报"X is not registered"，对应模型类未注册
            msg = str(exc)
            if "is not registered" in msg:
                raise BackendError(
                    f"该模型需要 funasr 不内置的自定义模型类（{msg.strip()}）。"
                    f"通常需要从作者仓库单独下载 model.py 并配置 remote_code，"
                    f"当前 backend 暂不支持。可考虑切换到其他模型。"
                ) from exc
            raise BackendError(f"FunASR 加载失败: {self.model_path}") from exc
        except Exception as exc:
            raise BackendError(f"FunASR 加载失败: {self.model_path} — {exc}") from exc
        logger.info("FunASR 加载完成")

    def transcribe(self, audio_path: str) -> tuple[str, int]:
        if self._model is None:
            raise BackendError("backend 未加载")
        t0 = time.perf_counter()
        try:
            results = self._model.generate(
                input=audio_path,
                cache={},
                language="auto",
                use_itn=True,           # SenseVoice 内置文本规范化
                batch_size_s=60,
            )
        except Exception as exc:
            raise BackendError(f"FunASR 推理失败: {audio_path}") from exc
        ms = int((time.perf_counter() - t0) * 1000)
        if not results:
            raise BackendError(f"FunASR 推理返回空结果: {audio_path}")
        # funasr 返回 list[dict{text:..., key:...}]
        text = (results[0] or {}).get("text", "")
        text = _strip_special_tokens(text)
        if not text:
            raise BackendError(f"FunASR 推理返回空文本: {audio_path}")
        return text, ms

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


# SenseVoice 的输出常带 <|zh|><|NEUTRAL|><|Speech|><|withitn|> 这种 tag
_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _strip_special_tokens(text: str) -> str:
    return _SENSEVOICE_TAG_RE.sub("", text).strip()
