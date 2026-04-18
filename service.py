import torch
from pathlib import Path
from qwen_asr import Qwen3ASRModel
from logger import setup_logger

logger = setup_logger(__name__)

MODEL_PATH = Path(__file__).parent / "models" / "Qwen3-ASR-1.7B"

# 模型单例
_model = None


def load_model():
    """加载或返回已缓存的模型"""
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
    """
    转写音频文件，返回原始文本。
    """
    model = load_model()
    results = model.transcribe(audio_path, language=None)
    return results[0].text
