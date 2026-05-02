"""ASR Backend 注册表 + 自动检测。

每个 backend 实现 ``Backend`` 协议（load / transcribe / unload）。
``detect_backend(path)`` 按目录指纹返回最合适的 backend 类。
"""
from __future__ import annotations

from pathlib import Path

from app.backends.base import Backend, BackendError
from app.backends.funasr import FunAsrBackend
from app.backends.qwen import QwenAsrBackend

# 注册顺序 = 检测优先级。第一个 ``can_handle`` 返回 True 的胜出。
# Qwen 优先：Qwen 模型目录里 config.json 含 architectures，FunASR 兜底
_REGISTRY: list[type[Backend]] = [QwenAsrBackend, FunAsrBackend]


def register(backend_cls: type[Backend]) -> None:
    """允许其他模块（如 app.backends.funasr）在 import 时把自己加进去。"""
    if backend_cls not in _REGISTRY:
        _REGISTRY.append(backend_cls)


def detect_backend(model_path: Path) -> type[Backend]:
    """按注册顺序问每个 backend 能否处理；都不行就 ``BackendError``。"""
    for cls in _REGISTRY:
        try:
            if cls.can_handle(model_path):
                return cls
        except Exception:
            # 单个 backend 的检测异常不影响后续候选
            continue
    raise BackendError(f"未识别的模型类型: {model_path}")


__all__ = ["Backend", "BackendError", "detect_backend", "register"]
