"""Backend 抽象与共享类型。"""
from __future__ import annotations

from pathlib import Path
from typing import NamedTuple, Protocol, runtime_checkable


class TranscribeResult(NamedTuple):
    raw: str
    final: str       # 后处理之后的文本（normalize_numbers 等）
    inference_ms: int


class BackendError(RuntimeError):
    """Backend 加载/检测失败的统一异常。"""


@runtime_checkable
class Backend(Protocol):
    """ASR Backend 协议。

    每个具体实现是一个类。使用流程：
        1. ``cls.can_handle(path)`` 判断是否能处理这个目录
        2. 实例化 ``cls(model_path, device, dtype)``
        3. 调用 ``self.load()``（同步阻塞，加载到内存/显存）
        4. 调用 ``self.transcribe(audio_path)`` 拿原始文本（不含后处理）
        5. 切换到别的 backend 前调用 ``self.unload()``
    """

    @classmethod
    def can_handle(cls, model_path: Path) -> bool: ...

    def load(self) -> None: ...

    def transcribe(self, audio_path: str) -> tuple[str, int]:
        """返回 (原始文本, inference_ms)；后处理由调用方完成。"""
        ...

    def unload(self) -> None: ...
