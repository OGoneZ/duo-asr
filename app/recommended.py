"""推荐模型清单：手挑的 ASR 模型，按 family 分组。

每个 family 包含若干 variant（不同参数规模、量化方式、是否带 VAD/标点等）。
variant 的 ``label`` 直接用 model_id 末段全名，避免再起一层简称。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RecommendedVariant:
    model_id: str           # ModelScope 上的 org/name
    label: str              # 完整模型名（model_id 末段，不另起简称）
    backend: str            # qwen-asr / funasr / mlx
    size_human: str         # 存储大小（不带 ~ 前缀，前端统一加"存储约"前缀）
    params_b: float | None = None
    precision: str | None = None
    summary: str = ""
    available: bool = True

    def to_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "label": self.label,
            "backend": self.backend,
            "size_human": self.size_human,
            "params_b": self.params_b,
            "precision": self.precision,
            "summary": self.summary,
            "available": self.available,
        }


@dataclass(frozen=True)
class RecommendedFamily:
    family_id: str
    name: str
    summary: str
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
            "variants": [v.to_dict() for v in self.variants],
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
                label="Qwen3-ASR-1.7B",
                params_b=1.7,
                precision="FP16",
                backend="qwen-asr",
                size_human="4.4 GB",
                summary="主力版本，最高准确率",
            ),
            RecommendedVariant(
                model_id="Qwen/Qwen3-ASR-0.6B",
                label="Qwen3-ASR-0.6B",
                params_b=0.6,
                precision="FP16",
                backend="qwen-asr",
                size_human="1.6 GB",
                summary="参数更小，加载快、显存低",
            ),
        ),
    ),
    RecommendedFamily(
        family_id="fun-asr",
        name="Fun-ASR Nano",
        summary="千问团队 + FunAudioLLM 联合，LLM 风格 ASR；中文/方言/英日多语种",
        languages=("中文", "中文方言", "英文", "日文"),
        tags=("dialect", "multilingual"),
        variants=(
            RecommendedVariant(
                model_id="FunAudioLLM/Fun-ASR-Nano-2512",
                label="Fun-ASR-Nano-2512",
                params_b=0.6,
                precision="FP16",
                backend="funasr",
                size_human="1.5 GB",
                summary="69 万下载，最稳定的版本",
            ),
            RecommendedVariant(
                model_id="fengge2024/Fun-ASR-Nano-2512-8bit",
                label="Fun-ASR-Nano-2512-8bit",
                params_b=0.6,
                precision="INT8",
                backend="funasr",
                size_human="750 MB",
                summary="8bit 量化版，体积/显存减半",
            ),
            RecommendedVariant(
                model_id="FunAudioLLM/Fun-ASR-MLT-Nano-2512",
                label="Fun-ASR-MLT-Nano-2512",
                params_b=0.6,
                precision="FP16",
                backend="funasr",
                size_human="1.5 GB",
                summary="多语言扩展版（multilingual）",
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
                label="SenseVoiceSmall",
                params_b=0.234,
                precision="FP16",
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
                label="speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                params_b=0.22,
                precision="FP16",
                backend="funasr",
                size_human="840 MB",
                summary="标准 Paraformer-Large",
            ),
            RecommendedVariant(
                model_id="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                label="speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                params_b=0.22,
                precision="FP16",
                backend="funasr",
                size_human="880 MB",
                summary="自带 VAD 端点检测和标点恢复，适合长音频",
            ),
            RecommendedVariant(
                model_id="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                label="speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                params_b=0.22,
                precision="FP16",
                backend="funasr",
                size_human="840 MB",
                summary="Paraformer + 热词增强，自定义词汇召回更高",
            ),
            RecommendedVariant(
                model_id="iic/speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn",
                label="speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn",
                params_b=0.22,
                precision="FP16",
                backend="funasr",
                size_human="900 MB",
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
                label="Whisper-large-v3-turbo",
                params_b=0.809,
                precision="FP16",
                backend="funasr",
                size_human="1.5 GB",
                summary="最新 Turbo 版本，速度比 v3 提升 4 倍",
            ),
        ),
    ),
]
