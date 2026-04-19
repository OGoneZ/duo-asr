import re
import tomllib
from pathlib import Path

from logger import setup_logger

logger = setup_logger(__name__)

# ── 热词 ──────────────────────────────────────────────────────────────────────

_HOTWORDS_FILE = Path(__file__).parent / "hotwords.toml"
_hotwords_cache: dict[str, list[str]] = {}
_hotwords_mtime_ns: int | None = None
_re_hotwords: re.Pattern[str] | None = None


def _compile_hotwords(hotwords: dict[str, list[str]]) -> re.Pattern[str] | None:
    all_variants = [variant for variants in hotwords.values() for variant in variants]
    if not all_variants:
        return None
    pattern = "|".join(re.escape(variant) for variant in all_variants)
    return re.compile(pattern, re.IGNORECASE)


def _load_hotwords() -> None:
    global _hotwords_cache, _hotwords_mtime_ns, _re_hotwords

    try:
        current_mtime_ns = _HOTWORDS_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        # 词典被移除时立即卸载热词替换能力。
        _hotwords_cache = {}
        _re_hotwords = None
        _hotwords_mtime_ns = None
        return

    if current_mtime_ns == _hotwords_mtime_ns:
        return

    try:
        data = tomllib.loads(_HOTWORDS_FILE.read_text(encoding="utf-8"))
        hotwords = data.get("hotwords", {})
        hotwords_regex = _compile_hotwords(hotwords)
    except Exception:
        # 解析失败时保留上一版，避免编辑过程中的中间态打断请求。
        logger.exception("热词词典加载失败，继续使用上一版本")
        _hotwords_mtime_ns = current_mtime_ns
        return

    _hotwords_cache = hotwords
    _re_hotwords = hotwords_regex
    _hotwords_mtime_ns = current_mtime_ns


def _sub_hotwords(text: str) -> str:
    _load_hotwords()
    if not _re_hotwords:
        return text
    return _re_hotwords.sub(lambda match: _lookup(match.group()), text)


def _lookup(variant: str) -> str:
    variant_lower = variant.lower()
    for canonical, variants in _hotwords_cache.items():
        for candidate in variants:
            if candidate.lower() == variant_lower:
                return canonical
    return variant


# ── 中文数字后处理 ────────────────────────────────────────────────────────────

_DIGIT_MAP = {
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "两": 2,
    "幺": 1,
}
_DC = r"[零一二三四五六七八九两幺]"
_UC = r"[十百千万亿]"


def _parse_section(s: str) -> int:
    val, cur = 0, 0
    for ch in s:
        if ch in _DIGIT_MAP:
            cur = _DIGIT_MAP[ch]
        elif ch == "十":
            val += (cur if cur else 1) * 10
            cur = 0
        elif ch == "百":
            val += cur * 100
            cur = 0
        elif ch == "千":
            val += cur * 1000
            cur = 0
    return val + cur


def _parse_int(s: str) -> int:
    if not s:
        return 0
    for unit, base in [("亿", 100_000_000), ("万", 10_000)]:
        if unit in s:
            index = s.index(unit)
            return _parse_int(s[:index]) * base + _parse_int(s[index + 1 :])
    return _parse_section(s)


def _dc(ch: str) -> str:
    return str(_DIGIT_MAP.get(ch, ch))


_ALL_NUM = r"[零一二三四五六七八九两幺十百千万亿]"
# 含单位字的数字；前瞻要求匹配范围内至少含一个数字字，
# 防止「百度」「万岁」「十分好」等裸单位字被误匹配为 0。
_RE_UNIT = re.compile(rf"(?={_ALL_NUM}*{_DC})(?:{_DC}*{_UC})+{_DC}*(?:点{_DC}+)?")
# IP 地址：每段允许含十/百（如「一百」=100），四组点分隔。
_IP_SEG = rf"[零一二三四五六七八九两幺十百]+"
_RE_IP = re.compile(rf"{_IP_SEG}(?:点{_IP_SEG}){{3}}")
# 纯小数，无单位字（三点一四）。
_RE_DEC = re.compile(rf"{_DC}+点{_DC}+")
# 时间前导：任意数字字符后跟「点 + DC序列 + 单位字」时转为阿拉伯数字。
# 覆盖所有「X点Y分/X点Y」场景，「三点一四」不含单位字故不触发。
_RE_TIME_LEAD = re.compile(rf"({_DC})(?=点{_DC}*{_UC})")
# 连续数字字符（≥2 个），逐字转换，覆盖年份/电话/门牌/含幺序列。
_RE_SEQ = re.compile(rf"{_DC}{{2,}}")
# 连续单个大写字母（S S H → SSH，D S P Y → DSPY）。
_RE_LETTER_SEQ = re.compile(r"(?<![A-Za-z])([A-Z])( [A-Z])+(?![A-Za-z])")
# X at/艾特 Y → X@Y（email/地址中的 @ 读法）。
_RE_AT = re.compile(r"(\S+?)(?:\s*at\s*|\s*艾特\s*)(\S+)", re.IGNORECASE)
# 点 + 字母 → .字母（域名/邮箱后缀，如「点com」→「.com」）。
_RE_DOT_ALPHA = re.compile(r"点([a-zA-Z]+)")
# 中文字符与阿拉伯数字之间插空格。
_RE_SPACE_L = re.compile(r"(?<=[^\x00-\x7F\s])(?=\d)")
_RE_SPACE_R = re.compile(r"(?<=\d)(?=[^\x00-\x7F\s])")


def _sub_unit(m: re.Match[str]) -> str:
    s = m.group()
    if "点" in s:
        integer_part, decimal_part = s.split("点", 1)
        return f'{_parse_int(integer_part)}.{"".join(_dc(ch) for ch in decimal_part)}'
    return str(_parse_int(s))


def _sub_dec(m: re.Match[str]) -> str:
    integer_part, decimal_part = m.group().split("点", 1)
    return f'{_parse_int(integer_part)}.{"".join(_dc(ch) for ch in decimal_part)}'


def _parse_ip_seg(s: str) -> str:
    if any(ch in "十百" for ch in s):
        return str(_parse_int(s))
    return "".join(_dc(ch) for ch in s)


def _sub_ip(m: re.Match[str]) -> str:
    return ".".join(_parse_ip_seg(part) for part in m.group().split("点"))


def _sub_seq(m: re.Match[str]) -> str:
    return "".join(_dc(ch) for ch in m.group())


def normalize_numbers(text: str) -> str:
    text = _RE_IP.sub(_sub_ip, text)  # IP 地址
    text = _RE_TIME_LEAD.sub(lambda match: _dc(match.group(1)), text)  # 时间前导数字
    text = _RE_UNIT.sub(_sub_unit, text)  # 含单位字的数字
    text = _RE_DEC.sub(_sub_dec, text)  # 纯小数
    text = _RE_SEQ.sub(_sub_seq, text)  # 连续数字序列
    text = _RE_LETTER_SEQ.sub(lambda match: match.group().replace(" ", ""), text)  # S S H → SSH
    text = _RE_AT.sub(r"\1@\2", text)  # at/艾特 → @
    text = _RE_DOT_ALPHA.sub(r".\1", text)  # 点com → .com
    text = _RE_SPACE_L.sub(" ", text)
    text = _RE_SPACE_R.sub(" ", text)
    return _sub_hotwords(text)  # 热词替换（可热更新）
