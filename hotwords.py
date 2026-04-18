import re
import tomllib
from pathlib import Path

_HOTWORDS_FILE = Path(__file__).parent / "hotwords.toml"
# key=目标写法，value=list[错误变体]
_cache: dict[str, list[str]] = {}
_mtime: float = 0.0
_re_hotwords: re.Pattern | None = None


def _reload_if_needed():
    global _cache, _mtime, _re_hotwords
    try:
        current_mtime = _HOTWORDS_FILE.stat().st_mtime
    except FileNotFoundError:
        return
    if current_mtime != _mtime:
        _mtime = current_mtime
        data = tomllib.loads(_HOTWORDS_FILE.read_text(encoding="utf-8"))
        _cache = data.get("hotwords", {})
        # 合并所有变体，生成 case-insensitive regex
        all_variants = [v for variants in _cache.values() for v in variants]
        if all_variants:
            pattern = '|'.join(re.escape(v) for v in all_variants)
            _re_hotwords = re.compile(pattern, re.IGNORECASE)
        else:
            _re_hotwords = None


def sub_hotwords(text: str) -> str:
    _reload_if_needed()
    if not _re_hotwords:
        return text
    return _re_hotwords.sub(lambda m: _lookup(m.group()), text)


def _lookup(variant: str) -> str:
    for canonical, variants in _cache.items():
        for v in variants:
            if v.lower() == variant.lower():
                return canonical
    return variant
