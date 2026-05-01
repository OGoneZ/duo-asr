from qwen_asr import Qwen3ASRModel

import config
import hot_reload
from errors import ModelLoadError, PostProcessError, TranscriptionError
from logger import setup_logger

logger = setup_logger(__name__)

_model = None


def load_model():
    global _model
    if _model is None:
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


def transcribe(audio_path: str) -> str:
    model = load_model()
    try:
        results = model.transcribe(audio_path, language=None)
    except Exception as exc:
        logger.exception("模型推理失败: %s", audio_path)
        raise TranscriptionError(f"模型推理失败: {audio_path}") from exc

    if not results or not getattr(results[0], "text", None):
        logger.error("模型推理返回空结果: %s, results=%r", audio_path, results)
        raise TranscriptionError(f"模型推理返回空结果: {audio_path}")

    raw = results[0].text
    try:
        normalized = hot_reload.normalize_numbers(raw)
    except Exception as exc:
        logger.exception("后处理失败: audio_path=%s, raw=%r", audio_path, raw)
        raise PostProcessError(f"后处理失败: {audio_path}") from exc

    logger.info(f"原始输出: {raw}")
    logger.info(f"后处理后: {normalized}")
    return normalized
