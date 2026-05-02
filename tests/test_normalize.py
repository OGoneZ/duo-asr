import importlib
import os
import sys
from pathlib import Path

import pytest

from app.post_process import core, hot_reload
from app.post_process import normalize_numbers

_ORIGINAL_HOTWORDS_PATH = Path(core._HOTWORDS_FILE)
_ORIGINAL_HOTWORDS_TEXT = _ORIGINAL_HOTWORDS_PATH.read_text(encoding="utf-8")


def _write_with_new_mtime(path: Path, content: str) -> None:
    current_mtime_ns = path.stat().st_mtime_ns if path.exists() else 0
    next_mtime_ns = max(current_mtime_ns + 1_000_000, int(Path.cwd().stat().st_mtime_ns))
    path.write_text(content, encoding="utf-8")
    os.utime(path, ns=(next_mtime_ns, next_mtime_ns))


@pytest.fixture(autouse=True)
def reset_runtime_state():
    importlib.reload(core)
    importlib.reload(hot_reload)
    yield
    importlib.reload(core)
    importlib.reload(hot_reload)


@pytest.fixture
def hotwords_file(tmp_path):
    hotwords_path = Path(core._HOTWORDS_FILE)
    backup_path = tmp_path / "hotwords.toml.bak"
    backup_path.write_text(_ORIGINAL_HOTWORDS_TEXT, encoding="utf-8")

    yield hotwords_path

    _write_with_new_mtime(hotwords_path, backup_path.read_text(encoding="utf-8"))
    importlib.reload(core)
    importlib.reload(hot_reload)


@pytest.fixture
def reloadable_modules(tmp_path):
    """构造一个临时目录里独立的 core + hot_reload 副本，不污染主 app 包。"""
    module_dir = tmp_path / "reloadable"
    module_dir.mkdir()
    hotwords_path = module_dir / "hotwords.toml"
    core_path = module_dir / "tmp_core.py"
    hot_reload_path = module_dir / "tmp_hot_reload.py"

    # 改写 core: 把 app 依赖换掉（独立模块不依赖 app 包），
    # _HOTWORDS_FILE 指向同目录的 hotwords.toml
    core_src = Path(core.__file__).read_text(encoding="utf-8")
    core_src = core_src.replace(
        "from app import config\nfrom app.logger import setup_logger",
        "import logging\nsetup_logger = lambda name=None: logging.getLogger(name)\nclass _Cfg: pass\nconfig = _Cfg()",
    )
    core_src = core_src.replace(
        "_HOTWORDS_FILE = config.HOTWORDS_FILE",
        '_HOTWORDS_FILE = Path(__file__).parent / "hotwords.toml"',
    )
    core_path.write_text(core_src, encoding="utf-8")

    # 改写 hot_reload: 改成从同目录加载 tmp_core
    hot_reload_src = Path(hot_reload.__file__).read_text(encoding="utf-8")
    hot_reload_src = hot_reload_src.replace(
        "from app.post_process import core",
        "import tmp_core as core",
    )
    hot_reload_src = hot_reload_src.replace(
        "from app.logger import setup_logger",
        "import logging\nsetup_logger = lambda name=None: logging.getLogger(name)",
    )
    hot_reload_src = hot_reload_src.replace(
        '_POST_PROCESS_FILE = Path(__file__).parent / "core.py"',
        '_POST_PROCESS_FILE = Path(__file__).parent / "tmp_core.py"',
    )
    hot_reload_path.write_text(hot_reload_src, encoding="utf-8")

    hotwords_path.write_text('[hotwords]\nFastAPI = ["fast api"]\n', encoding="utf-8")

    sys.path.insert(0, str(module_dir))
    try:
        sys.modules.pop("tmp_core", None)
        sys.modules.pop("tmp_hot_reload", None)
        reloadable_core = importlib.import_module("tmp_core")
        reloadable_hot_reload = importlib.import_module("tmp_hot_reload")
        yield {
            "module_dir": module_dir,
            "post_process": reloadable_core,
            "hot_reload": reloadable_hot_reload,
            "post_process_path": core_path,
            "hotwords_path": hotwords_path,
        }
    finally:
        sys.modules.pop("tmp_core", None)
        sys.modules.pop("tmp_hot_reload", None)
        sys.path.remove(str(module_dir))


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
    ("还有两个是没改的",  "还有两个是没改的"),
    ("两只猫",           "两只猫"),
    ("两点之间",         "两点之间"),
    ("百度一下",         "百度一下"),
    ("万岁",             "万岁"),
    ("千禧年",           "千禧年"),
    ("亿万富翁",         "亿万富翁"),
    ("十分好",           "十分好"),
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
    ("lab at幺零点幺点幺点六",            "lab@10.1.1.6"),
    ("ssh lab at幺零点幺点幺点六",        "ssh lab@10.1.1.6"),
    ("多at六六点六六点一点二",            "多@66.66.1.2"),
    ("珠宝多at六六点六六点一点二",        "zhubaoduo@66.66.1.2"),
])
def test_at_sign(text, expected):
    assert normalize_numbers(text) == expected


# ── 域名 / 邮箱后缀（点 + 字母） ─────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("example点com",                        "example.com"),
    ("example点 com",                       "example.com"),
    ("www点example点com",                   "www.example.com"),
    ("user艾特example点com",                "user@example.com"),
    ("user艾特example点 com",               "user@example.com"),
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
    ("S S H",                   "SSH"),
    ("D S P Y",                 "DSPy"),
    ("A P I",                   "API"),
    ("通过 S S H 连接",          "通过 SSH 连接"),
    ("使用 D S P Y 框架",        "使用 DSPy 框架"),
    ("A I",                     "AI"),
    ("U R L",                   "URL"),
    ("I love it",               "I love it"),
    ("SSH",                     "SSH"),
])
def test_letter_seq(text, expected):
    assert normalize_numbers(text) == expected


# ── 热词替换 ───────────────────────────────────────────────────────────────────

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


# ── 热词按发音匹配 ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, expected", [
    ("珠宝多", "zhubaoduo"),
    ("珠宝夺", "zhubaoduo"),
    ("我叫珠宝多", "我叫zhubaoduo"),
    ("我叫珠宝夺", "我叫zhubaoduo"),
])
def test_phonetic_hotwords(text, expected):
    assert normalize_numbers(text) == expected


# ── 热词按发音匹配不误伤 ───────────────────────────────────────────────────────

def test_phonetic_hotwords_no_false_positive():
    assert normalize_numbers("珠宝") == "珠宝"
    assert normalize_numbers("宝夺") == "宝夺"
    assert normalize_numbers("乐居") == "乐居"
    assert normalize_numbers("robot") == "robot"


# ── 热词热更新 ─────────────────────────────────────────────────────────────────

def test_hotwords_hotswap(hotwords_file):
    _write_with_new_mtime(hotwords_file, '[hotwords]\nFOO = ["foo"]\n')
    assert normalize_numbers("hello foo world") == "hello FOO world"

    _write_with_new_mtime(hotwords_file, '[hotwords]\nBAR = ["bar"]\n')
    assert normalize_numbers("hello foo world") == "hello foo world"
    assert normalize_numbers("hello bar world") == "hello BAR world"


def test_hotwords_removed_unloads_dictionary(hotwords_file):
    _write_with_new_mtime(hotwords_file, '[hotwords]\nFOO = ["foo"]\n')
    assert normalize_numbers("hello foo world") == "hello FOO world"

    hotwords_file.unlink()
    assert normalize_numbers("hello foo world") == "hello foo world"


def test_hotwords_invalid_keeps_last_good(hotwords_file):
    _write_with_new_mtime(hotwords_file, '[hotwords]\nFOO = ["foo"]\n')
    assert normalize_numbers("hello foo world") == "hello FOO world"

    _write_with_new_mtime(hotwords_file, '[hotwords\nBROKEN = ["bar"]\n')
    assert normalize_numbers("hello foo world") == "hello FOO world"
    assert normalize_numbers("hello bar world") == "hello bar world"


# ── 热词按发音匹配热更新 ───────────────────────────────────────────────────────

def test_hotwords_phonetic_hotswap(hotwords_file):
    _write_with_new_mtime(
        hotwords_file,
        '[hotwords.foo]\nvariants = ["福"]\nphonetic = true\npinyin = ["fu"]\n',
    )
    assert normalize_numbers("福") == "foo"
    assert normalize_numbers("夫") == "foo"

    _write_with_new_mtime(
        hotwords_file,
        '[hotwords.bar]\nvariants = ["巴"]\nphonetic = true\npinyin = ["ba"]\n',
    )
    assert normalize_numbers("福") == "福"
    assert normalize_numbers("八") == "bar"


# ── 后处理代码热更新 ───────────────────────────────────────────────────────────

def test_post_process_code_hotreload_uses_new_logic(reloadable_modules):
    reloadable_hot_reload = reloadable_modules["hot_reload"]
    post_process_path = reloadable_modules["post_process_path"]

    assert reloadable_hot_reload.normalize_numbers("三十二度") == "32 度"

    source = post_process_path.read_text(encoding="utf-8")
    old = '    text = _RE_SPACE_R.sub(" ", text)\n    return _sub_hotwords(text)  # 热词替换（可热更新）\n'
    new = '    text = _RE_SPACE_R.sub(" ", text)\n    return f"[patched]{_sub_hotwords(text)}"\n'
    assert old in source
    _write_with_new_mtime(post_process_path, source.replace(old, new, 1))

    assert reloadable_hot_reload.normalize_numbers("三十二度") == "[patched]32 度"


# ── 后处理代码热更新失败回退 ───────────────────────────────────────────────────

def test_post_process_code_hotreload_keeps_last_good_on_error(reloadable_modules):
    reloadable_hot_reload = reloadable_modules["hot_reload"]
    post_process_path = reloadable_modules["post_process_path"]

    assert reloadable_hot_reload.normalize_numbers("三十二度") == "32 度"

    _write_with_new_mtime(post_process_path, "def normalize_numbers(:\n")

    assert reloadable_hot_reload.normalize_numbers("三十二度") == "32 度"
