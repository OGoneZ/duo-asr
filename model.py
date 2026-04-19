import torch
from pathlib import Path
from qwen_asr import Qwen3ASRModel
import hot_reload
from logger import setup_logger

logger = setup_logger(__name__)

MODEL_PATH = Path(__file__).parent / "models" / "Qwen3-ASR-1.7B"

_model = None


def load_model():
    global _model
    if _model is None:
        logger.info(f"正在加载模型: {MODEL_PATH}")
        _model = Qwen3ASRModel.from_pretrained(
            str(MODEL_PATH),
            dtype=torch.bfloat16,
            device_map="auto"
        )
        logger.info("模型加载完成!")
    return _model


def transcribe(audio_path: str) -> str:
    model = load_model()
    results = model.transcribe(audio_path, language=None)
    raw = results[0].text
    normalized = hot_reload.normalize_numbers(raw)
    logger.info(f"原始输出: {raw}")
    logger.info(f"后处理后: {normalized}")
    return normalized
