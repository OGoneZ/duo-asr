import pytest
from service import normalize_numbers


# ── 含单位字的数字 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("三十二度",                     "32 度"),
    ("三百二十五元",                  "325 元"),
    ("一千两百五十张",                "1250 张"),
    ("两百",                         "200"),
    ("两千三百二十五个样例",           "2325 个样例"),
    ("一百零三",                      "103"),
    ("一百二十三万四千五百六十七元",   "1234567 元"),
    ("两亿三千万",                    "230000000"),
])
def test_unit_numbers(text, expected):
    assert normalize_numbers(text) == expected


# ── 「两」不误触发量词 ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("还有两个是没改的",  "还有两个是没改的"),
    ("两只猫",           "两只猫"),
    ("两点之间",         "两点之间"),
])
def test_liang_no_false_positive(text, expected):
    assert normalize_numbers(text) == expected


# ── 小数 ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("三点一四一五九",  "3.14159"),
    ("零点五",          "0.5"),
    ("三十二点五度",    "32.5 度"),
])
def test_decimal(text, expected):
    assert normalize_numbers(text) == expected


# ── 时间 ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("下午两点三十五分",  "下午 2 点 35 分"),
    ("三点五十四分",      "3 点 54 分"),
    ("四点五十四",        "4 点 54"),
    ("十二点整",          "12 点整"),
])
def test_time(text, expected):
    assert normalize_numbers(text) == expected


# ── 连续数字序列（年份、门牌、幺） ───────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("二零二五年",    "2025 年"),
    ("幺八幺三五七七",  "1813577"),
    ("幺零幺零",       "1010"),
    ("幺九二",         "192"),
])
def test_sequential(text, expected):
    assert normalize_numbers(text) == expected


# ── IP 地址 ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("幺零点幺零点二零点三二",      "10.10.20.32"),
    ("一九二点一六八点一点一",      "192.168.1.1"),
    ("幺九二点幺六八点五九点一百",  "192.168.59.100"),
    ("两百五十五点零点零点一",      "255.0.0.1"),
])
def test_ip(text, expected):
    assert normalize_numbers(text) == expected


# ── @ 符号 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("lab at 一九二点一六八点五九点一百",  "lab@192.168.59.100"),
    ("root艾特幺零点幺零点二零点三二",     "root@10.10.20.32"),
    ("root 艾特 一九二点一六八点一点一",   "root@192.168.1.1"),
    ("admin AT 一九二点一六八点一点一",    "admin@192.168.1.1"),
])
def test_at_sign(text, expected):
    assert normalize_numbers(text) == expected


# ── 数字与中文之间的空格 ──────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("共三百二十五张票",   "共 325 张票"),
    ("二零二五年开始",     "2025 年开始"),
])
def test_spacing(text, expected):
    assert normalize_numbers(text) == expected
