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
    path: str
    size_bytes: int
    valid: bool  # 目录里是否有 config 文件
    complete: bool  # 下载完整（无 modelscope 残留临时目录）
    is_current: bool

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "size_bytes": self.size_bytes,
            "size_human": _humanize_size(self.size_bytes),
            "valid": self.valid,
            "complete": self.complete,
            "is_current": self.is_current,
        }


def list_models() -> list[ModelInfo]:
    """扫 models/ 下所有一级子目录（含 symlink 目录），返回元信息列表。

    判定"有效模型"的最低标准：目录下存在以下任一配置文件：
      - config.json     （HuggingFace 习惯）
      - configuration.json（ModelScope 习惯）
      - config.yaml     （funasr / SenseVoice 习惯）
    其他文件（safetensors / pt 等）这里不强求，留给加载器自己报错。
    """
    base = config.MODELS_DIR
    if not base.is_dir():
        return []

    current_name = config.MODEL_NAME
    out: list[ModelInfo] = []
    for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        # ModelScope 在下载完成前可能留 ._____temp 子目录，跳过这种过渡态名
        if entry.name.startswith("."):
            continue
        valid = any(
            (entry / fname).is_file()
            for fname in ("config.json", "configuration.json", "config.yaml")
        )
        # ModelScope 下载未完成时会留下 ._____temp/ 子目录，里面是部分下载的
        # 大权重文件。完成后该目录被 SDK 清空。检测它的存在 = 未完成。
        temp_dir = entry / "._____temp"
        complete = not (temp_dir.is_dir() and any(temp_dir.iterdir()))
        out.append(
            ModelInfo(
                name=entry.name,
                path=str(entry.resolve()),
                size_bytes=_dir_size(entry),
                valid=valid,
                complete=complete,
                is_current=(entry.name == current_name),
            )
        )
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


def list_gguf_models() -> list[dict]:
    """扫描 models/ 下所有 .gguf 文件，返回元信息列表。

    只扫描一级，不递归子目录。每个条目:
      {name, path, size_bytes, size_human, is_current}
    """
    base = config.MODELS_DIR
    if not base.is_dir():
        return []
    current_name = config.POST_PROCESS_MODEL_NAME
    out: list[dict] = []
    for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file():
            continue
        if entry.suffix != ".gguf":
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            size = 0
        out.append(
            {
                "name": entry.name,
                "path": str(entry.resolve()),
                "size_bytes": size,
                "size_human": _humanize_size(size),
                "is_current": entry.name == current_name,
            }
        )
    return out


def _humanize_size(n: int) -> str:
    f = float(n)
    for u in _UNITS:
        if f < 1024 or u == _UNITS[-1]:
            return f"{f:.1f} {u}" if u != "B" else f"{int(f)} B"
        f /= 1024
    return f"{n} B"
