"""模型注册表：扫描 models/ 目录，描述每个已下载模型的元信息。

不负责加载/切换模型——那是 model.py 的事。这里只做"目录扫描 + 元数据"，
保持职责单一，方便 API 层引用。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from app import config


@dataclass
class ModelInfo:
    name: str
    path: str           # 字符串化的绝对路径
    size_bytes: int
    valid: bool         # 目录里是否有 config.json
    is_current: bool

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "size_bytes": self.size_bytes,
            "size_human": _humanize_size(self.size_bytes),
            "valid": self.valid,
            "is_current": self.is_current,
        }


def list_models() -> list[ModelInfo]:
    """扫 models/ 下所有一级子目录（含 symlink 目录），返回元信息列表。

    判定"有效模型"的最低标准：目录下存在 config.json。
    其他文件（safetensors 等）这里不强求，留给加载器自己报错。
    """
    base = config.MODELS_DIR
    if not base.is_dir():
        return []

    current_name = config.MODEL_NAME
    out: list[ModelInfo] = []
    for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        valid = (entry / "config.json").is_file()
        out.append(ModelInfo(
            name=entry.name,
            path=str(entry.resolve()),
            size_bytes=_dir_size(entry),
            valid=valid,
            is_current=(entry.name == current_name),
        ))
    return out


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path, followlinks=False):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                continue
    return total


_UNITS = ["B", "KB", "MB", "GB", "TB"]


def _humanize_size(n: int) -> str:
    f = float(n)
    for u in _UNITS:
        if f < 1024 or u == _UNITS[-1]:
            return f"{f:.1f} {u}" if u != "B" else f"{int(f)} B"
        f /= 1024
    return f"{n} B"
