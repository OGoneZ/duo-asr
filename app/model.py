"""模型加载 + 推理 + 切换 + 启动恢复（与具体 backend 解耦）。

通过 ``app.backends.detect_backend(path)`` 根据目录指纹挑选 backend，
统一通过 ``Backend`` 协议调度。切换/加载/释放都不感知具体实现。
"""

from __future__ import annotations

import threading
from typing import NamedTuple

from app import backends, config, post_process
from app.backends.base import Backend, BackendError
from app.errors import ModelLoadError, PostProcessError, TranscriptionError
from app.logger import setup_logger

logger = setup_logger(__name__)

_backend: Backend | None = None
_load_lock = threading.Lock()


class TranscribeResult(NamedTuple):
    raw: str
    final: str
    inference_ms: int


def _create_backend(model_path) -> Backend:
    try:
        cls = backends.detect_backend(model_path)
    except BackendError as exc:
        raise ModelLoadError(str(exc)) from exc
    return cls(model_path, config.DEVICE, config.DTYPE)


def load_model() -> Backend:
    """单例 lazy 加载当前激活模型。"""
    global _backend
    if _backend is not None:
        return _backend
    with _load_lock:
        if _backend is not None:
            return _backend
        logger.info("加载模型: %s", config.MODEL_PATH)
        try:
            backend = _create_backend(config.MODEL_PATH)
            backend.load()
        except Exception as exc:
            logger.exception("模型加载失败: %s", config.MODEL_PATH)
            raise ModelLoadError(f"模型加载失败: {config.MODEL_PATH}") from exc
        _backend = backend
        logger.info(
            "模型加载完成: backend=%s", getattr(backend, "name", type(backend).__name__)
        )
        return _backend


def switch_model(new_name: str) -> None:
    """切换激活模型：unload 旧 backend → 更新 config → load 新 backend → 持久化。"""
    global _backend
    new_path = config.MODELS_DIR / new_name
    if not new_path.is_dir():
        raise ModelLoadError(f"目标模型目录不存在: {new_path}")

    with _load_lock:
        if new_name == config.MODEL_NAME and _backend is not None:
            return
        logger.info("切换模型: %s → %s", config.MODEL_NAME, new_name)
        old_name = config.MODEL_NAME
        old_path = config.MODEL_PATH

        # 1. 释放旧 backend
        if _backend is not None:
            try:
                _backend.unload()
            except Exception:
                logger.warning("旧 backend.unload 失败", exc_info=True)
            _backend = None

        # 2. 更新运行时 config
        config.MODEL_NAME = new_name
        config.MODEL_PATH = new_path

        # 3. 加载新 backend
        try:
            backend = _create_backend(new_path)
            backend.load()
        except BackendError as exc:
            logger.exception("切换后模型加载失败: %s", new_path)
            # 回滚
            config.MODEL_NAME = old_name
            config.MODEL_PATH = old_path
            try:
                old_backend = _create_backend(old_path)
                old_backend.load()
                _backend = old_backend
                logger.info("已回滚到旧模型: %s", old_name)
            except Exception:
                logger.error("回滚加载旧模型也失败，服务进入无模型状态", exc_info=True)
            raise ModelLoadError(str(exc)) from exc

        _backend = backend

        # 4. 持久化（成功才写）
        active_file = config.DATA_DIR / "active_model.txt"
        active_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = active_file.with_suffix(".txt.tmp")
        tmp.write_text(new_name, encoding="utf-8")
        tmp.replace(active_file)
        logger.info("模型切换完成: %s", new_name)


def restore_active_model_from_disk() -> None:
    """启动时调用：若 active_model.txt 存在且指向有效目录，更新 config。"""
    active_file = config.DATA_DIR / "active_model.txt"
    if not active_file.is_file():
        return
    try:
        name = active_file.read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("active_model.txt 读取失败，忽略", exc_info=True)
        return
    if not name:
        return
    target = config.MODELS_DIR / name
    if not target.is_dir():
        logger.warning("active_model.txt 指向不存在的目录，忽略: %s", target)
        return
    if name == config.MODEL_NAME:
        return
    logger.info("从持久化文件恢复激活模型: %s → %s", config.MODEL_NAME, name)
    config.MODEL_NAME = name
    config.MODEL_PATH = target


def transcribe(audio_path: str) -> TranscribeResult:
    backend = load_model()
    try:
        result = backend.transcribe(audio_path)
    except Exception as exc:
        logger.exception("模型推理失败: %s", audio_path)
        raise TranscriptionError(f"模型推理失败: {audio_path}") from exc

    # 协议要求返回 (raw, ms)；兜底处理空结果与意外形态
    try:
        raw, ms = result
    except (TypeError, ValueError) as exc:
        logger.error("模型推理返回非法形态: %s, result=%r", audio_path, result)
        raise TranscriptionError(f"模型推理返回空结果: {audio_path}") from exc
    if not raw:
        raise TranscriptionError(f"模型推理返回空结果: {audio_path}")

    try:
        normalized = post_process.normalize_numbers(raw)
    except Exception as exc:
        logger.exception("后处理失败: audio_path=%s, raw=%r", audio_path, raw)
        raise PostProcessError(f"后处理失败: {audio_path}") from exc

    # LLM 文本清理（provider="none" 时透传，零开销）
    try:
        final = post_process_model.process_text(normalized)
    except Exception:
        logger.exception("LLM 后处理失败，降级为归一化结果")
        final = normalized

    logger.info("原始输出: %s", raw)
    logger.info("后处理后: %s", normalized)
    if final != normalized:
        logger.info("LLM 清理后: %s", final)
    return TranscribeResult(raw=raw, final=final, inference_ms=ms)
