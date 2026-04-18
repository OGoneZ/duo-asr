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


# ── 裸单位字不误触发 ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("还有两个是没改的",  "还有两个是没改的"),   # 两 前无单位
    ("两只猫",           "两只猫"),
    ("两点之间",         "两点之间"),
    ("百度一下",         "百度一下"),            # 百 后无数字
    ("万岁",             "万岁"),
    ("千禧年",           "千禧年"),
    ("亿万富翁",         "亿万富翁"),
    ("十分好",           "十分好"),
    # 十 后紧跟数字/单位时仍正常转换
    ("十五度",           "15 度"),
    ("十二",             "12"),
    ("一百万",           "1000000"),
    ("三千万",           "30000000"),
])
def test_bare_unit_no_false_positive(text, expected):
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
    # at 右边无空格
    ("lab at幺零点幺点幺点六",            "lab@10.1.1.6"),
    ("ssh lab at幺零点幺点幺点六",        "ssh lab@10.1.1.6"),
    # at 前后均无空格（多at六六点六六点一点二 → 多@66.66.1.2）
    ("多at六六点六六点一点二",            "多@66.66.1.2"),
    ("珠宝多at六六点六六点一点二",        "珠宝多@66.66.1.2"),
])
def test_at_sign(text, expected):
    assert normalize_numbers(text) == expected


# ── 域名 / 邮箱后缀（点 + 字母） ─────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("example点com",                        "example.com"),
    ("www点example点com",                   "www.example.com"),
    ("user艾特example点com",                "user@example.com"),
    ("admin at 幺九二点一六八点一点一点cn",  "admin@192.168.1.1.cn"),
])
def test_dot_alpha(text, expected):
    assert normalize_numbers(text) == expected


# ── 数字与中文之间的空格 ──────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("共三百二十五张票",   "共 325 张票"),
    ("二零二五年开始",     "2025 年开始"),
])
def test_spacing(text, expected):
    assert normalize_numbers(text) == expected


# ── 大写字母序列合并 ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("S S H",                   "SSH"),      # ssh 不在热词中
    ("D S P Y",                 "DSPy"),     # dspy 在热词中，合并后再热词纠正
    ("A P I",                   "API"),
    ("通过 S S H 连接",          "通过 SSH 连接"),
    ("使用 D S P Y 框架",        "使用 DSPy 框架"),
    ("A I",                     "AI"),
    ("U R L",                   "URL"),
    # 单个字母不触发
    ("I love it",               "I love it"),
    # 已连写的不变
    ("SSH",                     "SSH"),
])
def test_letter_seq(text, expected):
    assert normalize_numbers(text) == expected


# ── 热词替换 ───────────────────────────────────────────────────────────────────

import hotwords as _hotwords_module

@pytest.mark.parametrize("text, expected", [
    ("用 fast api 构建服务",      "用 FastAPI 构建服务"),
    ("用 rag 做检索",            "用 RAG 做检索"),
    ("open ai 的接口",           "OpenAI 的接口"),
    ("lang chain 很好用",        "LangChain 很好用"),
    ("dspy 是一个框架",          "DSPy 是一个框架"),
    ("使用 Fast API 加速",       "使用 FastAPI 加速"),
])
def test_hotwords(text, expected):
    assert normalize_numbers(text) == expected


def test_hotwords_hotswap(tmp_path):
    import hotwords as hw

    # 保存原状态
    orig_file = hw._HOTWORDS_FILE
    orig_mtime = hw._mtime
    orig_cache = dict(hw._cache)
    orig_re = hw._re_hotwords

    # 切换到临时文件
    fake_file = tmp_path / "hotwords.toml"
    hw._HOTWORDS_FILE = fake_file
    hw._mtime = 0
    hw._re_hotwords = None
    hw._cache.clear()

    try:
        fake_file.write_text('[hotwords]\nFOO = ["foo", "f o o"]\n', encoding="utf-8")
        assert normalize_numbers("hello foo world") == "hello FOO world"
        assert normalize_numbers("hello f o o world") == "hello FOO world"

        fake_file.write_text('[hotwords]\nBAR = ["bar"]\n', encoding="utf-8")
        assert normalize_numbers("hello bar world") == "hello BAR world"
    finally:
        hw._HOTWORDS_FILE = orig_file
        hw._mtime = orig_mtime
        hw._cache.clear()
        hw._cache.update(orig_cache)
        hw._re_hotwords = orig_re
