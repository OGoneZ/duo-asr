"""后处理子系统：热词替换 + 数字转换 + 代码热重载。

外部统一通过 `from app.post_process import normalize_numbers` 调用，
内部 `core` 是规则实现，`hot_reload` 负责按 mtime 重载 core。
"""
from app.post_process.hot_reload import normalize_numbers

__all__ = ["normalize_numbers"]
