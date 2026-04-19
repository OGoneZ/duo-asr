import importlib
from pathlib import Path
from types import ModuleType

import post_process
from logger import setup_logger

logger = setup_logger(__name__)

# ── 后处理代码热重载 ──────────────────────────────────────────────────────────

_POST_PROCESS_FILE = Path(__file__).parent / "post_process.py"
_post_process_module: ModuleType = post_process
_checked_mtime_ns: int | None = None


def _read_mtime_ns() -> int | None:
    try:
        return _POST_PROCESS_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        logger.warning("后处理文件不存在，继续使用当前版本: %s", _POST_PROCESS_FILE)
        return None


def get_post_process_module() -> ModuleType:
    global _checked_mtime_ns, _post_process_module

    current_mtime_ns = _read_mtime_ns()
    if current_mtime_ns is None or current_mtime_ns == _checked_mtime_ns:
        return _post_process_module

    try:
        # 仅热更新后处理模块，模型实例始终留在 model.py 内。
        _post_process_module = importlib.reload(_post_process_module)
        logger.info("后处理模块已热更新: %s", _POST_PROCESS_FILE.name)
    except Exception:
        # reload 失败时继续使用上一版，避免语法错误直接打挂请求。
        logger.exception("后处理模块热更新失败，继续使用上一版本")
    finally:
        _checked_mtime_ns = current_mtime_ns

    return _post_process_module


def normalize_numbers(text: str) -> str:
    return get_post_process_module().normalize_numbers(text)
