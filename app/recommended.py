"""推荐模型清单：手挑的 ASR 模型，覆盖不同场景。

清单存在意义：用户不必去 ModelScope 翻 model_id 全称，点「下载」即可。
要新增推荐 → 改这里 + commit；要让用户改 → 现阶段不开放，避免误下大模型。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RecommendedModel:
    model_id: str          # ModelScope 上的 org/name
    name: str              # 展示名（短）
    backend: str           # qwen-asr / funasr
    size_human: str        # 估算大小
    summary: str           # 一句话特点
    languages: tuple[str, ...] = ()  # 主打语言（展示用）
    tags: tuple[str, ...] = ()       # 场景标签（搜索/筛选预留）

    def to_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "name": self.name,
            "backend": self.backend,
            "size_human": self.size_human,
            "summary": self.summary,
            "languages": list(self.languages),
            "tags": list(self.tags),
        }


# 顺序 = 推荐展示顺序。Qwen 系列优先，funasr 系列跟上。
RECOMMENDED: list[RecommendedModel] = [
    RecommendedModel(
        model_id="Qwen/Qwen3-ASR-1.7B",
        name="Qwen3-ASR",
        backend="qwen-asr",
        size_human="4.4 GB",
        summary="中文最强 + 热词理解 + 上下文感知；当前默认模型",
        languages=("中文", "英文"),
        tags=("hotwords", "context"),
    ),
    RecommendedModel(
        model_id="iic/SenseVoiceSmall",
        name="SenseVoice Small",
        backend="funasr",
        size_human="940 MB",
        summary="多语言 + 极速推理 + 情感/事件识别",
        languages=("中文", "英文", "粤语", "日文", "韩文"),
        tags=("multilingual", "fast", "emotion"),
    ),
    RecommendedModel(
        model_id="iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        name="Paraformer-Large",
        backend="funasr",
        size_human="~840 MB",
        summary="纯中文场景的经典选择，工业级稳定",
        languages=("中文",),
        tags=("zh", "stable"),
    ),
    RecommendedModel(
        model_id="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        name="Paraformer-Large + VAD + 标点",
        backend="funasr",
        size_human="~880 MB",
        summary="自带 VAD 端点检测和标点恢复，适合长音频",
        languages=("中文",),
        tags=("zh", "vad", "punctuation", "long-audio"),
    ),
    RecommendedModel(
        model_id="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        name="Seaco-Paraformer",
        backend="funasr",
        size_human="~840 MB",
        summary="Paraformer + 热词增强，自定义词汇召回更高",
        languages=("中文",),
        tags=("zh", "hotwords"),
    ),
    RecommendedModel(
        model_id="iic/Whisper-large-v3-turbo",
        name="Whisper Large v3 Turbo",
        backend="funasr",
        size_human="~1.5 GB",
        summary="OpenAI Whisper 多语言；抗噪强，适合英文/混合语种",
        languages=("英文", "多语言"),
        tags=("multilingual", "robust"),
    ),
]
