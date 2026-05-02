import gc
import threading
import time
from typing import NamedTuple

import torch
from qwen_asr import Qwen3ASRModel

from app import config, post_process
from app.errors import ModelLoadError, PostProcessError, TranscriptionError
from app.logger import setup_logger

logger = setup_logger(__name__)

_model = None
_load_lock = threading.Lock()


class TranscribeResult(NamedTuple):
    raw: str
    final: str
    inference_ms: int


def load_model():
    global _model
    # 双重检查锁定：避免高并发首次请求各自触发一次重型加载
    if _model is not None:
        return _model
    with _load_lock:
        if _model is not None:
            return _model
        logger.info(
            f"正在加载模型: {config.MODEL_PATH} "
            f"(device={config.DEVICE}, dtype={config.DTYPE})"
        )
        try:
            _model = Qwen3ASRModel.from_pretrained(
                str(config.MODEL_PATH),
                dtype=config.DTYPE,
                device_map={"": config.DEVICE},
            )
        except Exception as exc:
            logger.exception("模型加载失败: %s", config.MODEL_PATH)
            raise ModelLoadError(f"模型加载失败: {config.MODEL_PATH}") from exc
        logger.info("模型加载完成!")
        return _model


def switch_model(new_name: str) -> None:
    """切换激活模型：释放旧实例 → 更新 config 路径 → 加载新实例 → 持久化选择。

    持久化文件 ``data/active_model.txt`` 用于服务重启后恢复选择。
    """
    global _model
    new_path = config.MODELS_DIR / new_name
    if not new_path.is_dir():
        raise ModelLoadError(f"目标模型目录不存在: {new_path}")

    with _load_lock:
        if new_name == config.MODEL_NAME and _model is not None:
            return  # 已经是当前激活，无须切换
        logger.info("切换模型: %s → %s", config.MODEL_NAME, new_name)
        old_name = config.MODEL_NAME
        old_path = config.MODEL_PATH

        # 1. 释放旧模型
        old = _model
        _model = None
        del old
        gc.collect()
        if torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:
                logger.warning("torch.cuda.empty_cache 失败", exc_info=True)
        # MPS 没有公开的 empty_cache API；gc 后系统会回收

        # 2. 更新运行时 config
        config.MODEL_NAME = new_name
        config.MODEL_PATH = new_path

        # 3. 加载新模型（直接调内部加载逻辑，避免再次拿锁）
        logger.info(
            "加载新模型: %s (device=%s, dtype=%s)",
            config.MODEL_PATH, config.DEVICE, config.DTYPE,
        )
        try:
            _model = Qwen3ASRModel.from_pretrained(
                str(config.MODEL_PATH),
                dtype=config.DTYPE,
                device_map={"": config.DEVICE},
            )
        except Exception as exc:
            logger.exception("切换后模型加载失败: %s", config.MODEL_PATH)
            # 回滚 config + 尝试重新加载旧模型，恢复到切换前的可用状态
            config.MODEL_NAME = old_name
            config.MODEL_PATH = old_path
            try:
                _model = Qwen3ASRModel.from_pretrained(
                    str(old_path),
                    dtype=config.DTYPE,
                    device_map={"": config.DEVICE},
                )
                logger.info("已回滚到旧模型: %s", old_name)
            except Exception:
                logger.error("回滚加载旧模型也失败，服务进入无模型状态", exc_info=True)
            raise ModelLoadError(f"切换后模型加载失败: {new_path}") from exc

        # 4. 持久化（成功后才写，失败不污染选择）
        active_file = config.DATA_DIR / "active_model.txt"
        active_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = active_file.with_suffix(".txt.tmp")
        tmp.write_text(new_name, encoding="utf-8")
        tmp.replace(active_file)
        logger.info("模型切换完成: %s", new_name)


def restore_active_model_from_disk() -> None:
    """启动时调用：若 data/active_model.txt 存在且指向有效目录，
    把 config.MODEL_NAME / MODEL_PATH 切到它。
    实际模型加载仍由 lifespan 的 load_model() 触发。
    """
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
    model = load_model()
    t0 = time.perf_counter()
    try:
        results = model.transcribe(audio_path, language=None)
    except Exception as exc:
        logger.exception("模型推理失败: %s", audio_path)
        raise TranscriptionError(f"模型推理失败: {audio_path}") from exc
    inference_ms = int((time.perf_counter() - t0) * 1000)

    if not results or not getattr(results[0], "text", None):
        logger.error("模型推理返回空结果: %s, results=%r", audio_path, results)
        raise TranscriptionError(f"模型推理返回空结果: {audio_path}")

    raw = results[0].text
    try:
        normalized = post_process.normalize_numbers(raw)
    except Exception as exc:
        logger.exception("后处理失败: audio_path=%s, raw=%r", audio_path, raw)
        raise PostProcessError(f"后处理失败: {audio_path}") from exc

    logger.info(f"原始输出: {raw}")
    logger.info(f"后处理后: {normalized}")
    return TranscribeResult(raw=raw, final=normalized, inference_ms=inference_ms)
