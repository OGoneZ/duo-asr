"""推荐模型清单：手挑的 ASR 模型，按 family 分组。

每个 family 包含若干 variant（不同参数规模 / 量化方式 / 转换格式）。
要新增推荐 → 改这里 + commit；MLX / GGUF 等需要新 backend 的格式
等支持后再补充进来。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class RecommendedVariant:
    model_id: str        # ModelScope 上的 org/name
    label: str           # 短标签："1.7B (FP16)" / "0.6B" / "MLX 8bit"
    backend: str         # qwen-asr / funasr / mlx
    size_human: str
    summary: str = ""    # 这个 variant 的差异点（精简）
    available: bool = True   # False 表示当前服务尚不支持此 variant 的 backend


@dataclass(frozen=True)
class RecommendedFamily:
    family_id: str       # 用作前端 group key
    name: str            # 展示名
    summary: str         # family 简介
    languages: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    variants: tuple[RecommendedVariant, ...] = ()

    def to_dict(self) -> dict:
        return {
            "family_id": self.family_id,
            "name": self.name,
            "summary": self.summary,
            "languages": list(self.languages),
            "tags": list(self.tags),
            "variants": [v.__dict__ for v in self.variants],
        }


RECOMMENDED: list[RecommendedFamily] = [
    RecommendedFamily(
        family_id="qwen3-asr",
        name="Qwen3-ASR",
        summary="千问团队的 ASR 模型，中文最强 + 热词理解 + 上下文感知",
        languages=("中文", "英文"),
        tags=("hotwords", "context"),
        variants=(
            RecommendedVariant(
                model_id="Qwen/Qwen3-ASR-1.7B",
                label="1.7B (FP16)",
                backend="qwen-asr",
                size_human="4.4 GB",
                summary="主力版本，最高准确率",
            ),
            RecommendedVariant(
                model_id="Qwen/Qwen3-ASR-0.6B",
                label="0.6B (FP16)",
                backend="qwen-asr",
                size_human="~1.6 GB",
                summary="参数更小，加载快、显存低",
            ),
        ),
    ),
    RecommendedFamily(
        family_id="sensevoice",
        name="SenseVoice",
        summary="阿里 FunASR 系列，多语言 + 极速推理 + 情感/事件识别",
        languages=("中文", "英文", "粤语", "日文", "韩文"),
        tags=("multilingual", "fast", "emotion"),
        variants=(
            RecommendedVariant(
                model_id="iic/SenseVoiceSmall",
                label="Small",
                backend="funasr",
                size_human="940 MB",
                summary="轻量、上百倍实时速率",
            ),
        ),
    ),
    RecommendedFamily(
        family_id="paraformer",
        name="Paraformer-Large",
        summary="阿里 FunASR 中文 ASR 经典之选，工业级稳定",
        languages=("中文",),
        tags=("zh", "stable"),
        variants=(
            RecommendedVariant(
                model_id="iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                label="基础版",
                backend="funasr",
                size_human="~840 MB",
                summary="标准 Paraformer-Large",
            ),
            RecommendedVariant(
                model_id="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                label="+ VAD + 标点",
                backend="funasr",
                size_human="~880 MB",
                summary="自带 VAD 端点检测和标点恢复，适合长音频",
            ),
            RecommendedVariant(
                model_id="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                label="Seaco（热词版）",
                backend="funasr",
                size_human="~840 MB",
                summary="Paraformer + 热词增强，自定义词汇召回更高",
            ),
            RecommendedVariant(
                model_id="iic/speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn",
                label="+ VAD + 标点 + 说话人",
                backend="funasr",
                size_human="~900 MB",
                summary="加分角色识别（speaker diarization）",
            ),
        ),
    ),
    RecommendedFamily(
        family_id="whisper",
        name="Whisper",
        summary="OpenAI Whisper 多语言；抗噪强，适合英文/混合语种",
        languages=("英文", "多语言"),
        tags=("multilingual", "robust"),
        variants=(
            RecommendedVariant(
                model_id="iic/Whisper-large-v3-turbo",
                label="Large v3 Turbo",
                backend="funasr",
                size_human="~1.5 GB",
                summary="最新 Turbo 版本，速度比 v3 提升 4 倍",
            ),
        ),
    ),
]
