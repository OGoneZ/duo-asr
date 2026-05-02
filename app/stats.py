"""击键数估算：中文按拼音字符数计入，其他字符各自 1 击键。"""
from __future__ import annotations

from pypinyin import pinyin, Style


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF       # CJK 统一表意
        or 0x3400 <= code <= 0x4DBF    # 扩展 A
        or 0xF900 <= code <= 0xFAFF    # 兼容表意
    )


def estimate_keystrokes(text: str | None) -> int:
    if not text:
        return 0
    total = 0
    for ch in text:
        if _is_cjk(ch):
            py = pinyin(ch, style=Style.NORMAL, errors="ignore")
            if py and py[0]:
                total += len(py[0][0])
            else:
                total += 1
        else:
            total += 1
    return total
