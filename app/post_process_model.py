"""后处理模型管理 + 推理（singleton）。

三种 provider 模式:
  - "none":     透传，不做任何处理
  - "local":    进程内 llama-cpp-python 加载 4-bit GGUF
  - "endpoint": OpenAI-compatible /v1/chat/completions
"""

from __future__ import annotations

import gc
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from app import config
from app.logger import setup_logger

logger = setup_logger(__name__)

_llm = None
_load_lock = threading.Lock()
_http: httpx.Client | None = None


def _get_http() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=120.0)
    return _http


RECOMMENDED_LLM: list[dict] = [
    {
        "id": "qwen3.5-4b",
        "name": "Qwen3.5 4B (Q4_K_M)",
        "model_id": "unsloth/Qwen3.5-4B-GGUF",
        "file_name": "Qwen3.5-4B-Q4_K_M.gguf",
        "size_human": "~2.4 GB",
        "summary": "通义千问 3.5 4-bit 量化，速度快，中文优秀",
        "params_b": 4.0,
    },
]


@dataclass
class _Config:
    provider: str = "none"
    model_name: str = ""
    endpoint_url: str = ""
    endpoint_key: str = ""
    endpoint_model: str = ""
    prompt: str = ""

    def to_dict(self, mask_key: bool = False) -> dict:
        d = {
            "provider": self.provider,
            "model_name": self.model_name,
            "endpoint_url": self.endpoint_url,
            "endpoint_model": self.endpoint_model,
            "prompt": self.prompt,
        }
        if mask_key and self.endpoint_key:
            d["endpoint_key"] = "***" + self.endpoint_key[-4:]
        else:
            d["endpoint_key"] = self.endpoint_key
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "_Config":
        return cls(
            provider=d.get("provider", "none"),
            model_name=d.get("model_name", ""),
            endpoint_url=d.get("endpoint_url", ""),
            endpoint_key=d.get("endpoint_key", ""),
            endpoint_model=d.get("endpoint_model", ""),
            prompt=d.get("prompt", ""),
        )


_cfg = _Config()


def _sync_config_from_module() -> None:
    global _cfg
    _cfg = _Config(
        provider=config.POST_PROCESS_PROVIDER,
        model_name=config.POST_PROCESS_MODEL_NAME,
        endpoint_url=config.POST_PROCESS_ENDPOINT_URL,
        endpoint_key=config.POST_PROCESS_ENDPOINT_KEY,
        endpoint_model=config.POST_PROCESS_ENDPOINT_MODEL,
        prompt=config.POST_PROCESS_PROMPT,
    )


def _push_config_to_module() -> None:
    config.POST_PROCESS_PROVIDER = _cfg.provider
    config.POST_PROCESS_MODEL_NAME = _cfg.model_name
    config.POST_PROCESS_ENDPOINT_URL = _cfg.endpoint_url
    config.POST_PROCESS_ENDPOINT_KEY = _cfg.endpoint_key
    config.POST_PROCESS_ENDPOINT_MODEL = _cfg.endpoint_model
    if _cfg.prompt:
        config.POST_PROCESS_PROMPT = _cfg.prompt


def restore_config_from_disk() -> None:
    global _cfg
    cfg_file = config.POST_PROCESS_CONFIG_FILE
    if not cfg_file.is_file():
        _sync_config_from_module()
        return
    try:
        data = json.loads(cfg_file.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("后处理配置文件损坏，使用默认值", exc_info=True)
        _sync_config_from_module()
        return
    _cfg = _Config.from_dict(data)
    _push_config_to_module()
    logger.info("后处理配置已恢复: provider=%s", _cfg.provider)


def save_config_to_disk() -> None:
    cfg_file = config.POST_PROCESS_CONFIG_FILE
    cfg_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg_file.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(_cfg.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(cfg_file)


def get_config() -> dict:
    from app.models_registry import list_llm_models

    prompt = _cfg.prompt or config.POST_PROCESS_PROMPT
    d = _cfg.to_dict(mask_key=True)
    d["prompt"] = prompt
    d["default_prompt"] = config.POST_PROCESS_PROMPT
    d["local_models"] = list_llm_models()
    d["recommended"] = RECOMMENDED_LLM
    return d


def reload_default_prompt() -> dict:
    fresh = config._load_default_prompt()
    config.POST_PROCESS_PROMPT = fresh
    if not _cfg.prompt:
        _cfg.prompt = fresh
    return {"prompt": _cfg.prompt, "default_prompt": fresh}


def update_config(data: dict) -> dict:
    global _cfg
    need_reload = False
    if "provider" in data:
        new_provider = data["provider"]
        if new_provider not in ("none", "local", "endpoint"):
            raise ValueError(f"非法的 provider: {new_provider}")
        if new_provider != _cfg.provider:
            _cfg.provider = new_provider
            need_reload = True
    if "model_name" in data:
        if data["model_name"] != _cfg.model_name:
            _cfg.model_name = data["model_name"]
            need_reload = True
    if "endpoint_url" in data:
        _cfg.endpoint_url = data["endpoint_url"]
    if "endpoint_model" in data:
        _cfg.endpoint_model = data["endpoint_model"]
    if "endpoint_key" in data:
        key = data["endpoint_key"]
        if not (key.startswith("***") and len(key) <= 7):
            _cfg.endpoint_key = key
    if "prompt" in data:
        _cfg.prompt = data["prompt"]
    _push_config_to_module()
    save_config_to_disk()
    if need_reload:
        _handle_reload()
    return get_config()


# ── local 模型生命周期 ──────────────────────────────────


def _resolve_model_path() -> Path | None:
    if not _cfg.model_name:
        return None
    p = config.LLM_MODELS_DIR / _cfg.model_name
    if p.is_file():
        return p
    return None


def _ensure_cuda_library() -> None:
    """设置 LLAMA_CPP_LIB 指向 conda 的 CUDA 版 libllama.so，启用 GPU 加速。"""
    import os as _os

    if "LLAMA_CPP_LIB" in _os.environ:
        return
    candidates = [
        _os.path.expanduser("~/miniforge3/lib/libllama.so"),
        _os.path.expanduser("~/anaconda3/lib/libllama.so"),
    ]
    for p in candidates:
        if _os.path.isfile(p):
            _os.environ["LLAMA_CPP_LIB"] = p
            logger.info("使用 CUDA 版 llama.cpp: %s", p)
            return
    logger.warning("未找到 conda CUDA 版 libllama.so，将使用 CPU 推理")


def _load_local_model() -> None:
    global _llm
    if _llm is not None:
        return
    model_path = _resolve_model_path()
    if model_path is None:
        logger.warning("未找到 GGUF 文件: %s", _cfg.model_name)
        return
    try:
        from llama_cpp import Llama
    except ImportError:
        logger.error("llama-cpp-python 未安装")
        return
    _ensure_cuda_library()
    logger.info("加载后处理模型: %s", model_path)
    try:
        _llm = Llama(
            model_path=str(model_path),
            n_gpu_layers=-1,
            n_ctx=2048,
            offload_kqv=True,
            verbose=False,
        )
    except Exception:
        logger.exception("后处理模型加载失败: %s", model_path)
        _llm = None
        return
    logger.info("后处理模型加载完成")


def _unload_local_model() -> None:
    global _llm
    old = _llm
    _llm = None
    del old
    gc.collect()


def _handle_reload() -> None:
    with _load_lock:
        if _cfg.provider == "local":
            _unload_local_model()
            _load_local_model()
        else:
            _unload_local_model()


def switch_model(name: str) -> None:
    target = config.LLM_MODELS_DIR / name
    if not target.is_file():
        raise FileNotFoundError(f"GGUF 文件不存在: {target}")
    _cfg.model_name = name
    _push_config_to_module()
    save_config_to_disk()
    with _load_lock:
        _unload_local_model()
        _load_local_model()
    logger.info("后处理模型切换完成: %s", name)


# ── 推理 ────────────────────────────────────────────────


def process_text(text: str) -> str:
    if _cfg.provider == "none":
        return text
    if not text or not text.strip():
        return text
    prompt = _cfg.prompt or config.POST_PROCESS_PROMPT
    if not prompt:
        return text
    try:
        if _cfg.provider == "local":
            return _process_local(text, prompt)
        if _cfg.provider == "endpoint":
            return _process_endpoint(text, prompt)
    except Exception:
        logger.exception("LLM 后处理失败，降级为原文本")
    return text


def _process_local(text: str, prompt: str) -> str:
    global _llm
    if _llm is None:
        with _load_lock:
            if _llm is None:
                _load_local_model()
    if _llm is None:
        logger.warning("本地后处理模型未加载，降级透传")
        return text
    response = _llm.create_chat_completion(
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ],
        max_tokens=1024,
        temperature=0.1,
        top_p=0.9,
    )
    result = response["choices"][0]["message"]["content"]
    return result.strip() if result else text


def _process_endpoint(text: str, prompt: str) -> str:
    url = _cfg.endpoint_url.rstrip("/")
    if not url:
        logger.warning("endpoint URL 为空，降级透传")
        return text
    headers = {"Content-Type": "application/json"}
    if _cfg.endpoint_key:
        headers["Authorization"] = f"Bearer {_cfg.endpoint_key}"
    payload = {
        "model": _cfg.endpoint_model or "default",
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ],
        "max_tokens": 1024,
        "temperature": 0.1,
    }
    resp = _get_http().post(f"{url}/v1/chat/completions", json=payload, headers=headers)
    resp.raise_for_status()
    result = resp.json()["choices"][0]["message"]["content"]
    return result.strip() if result else text


def test_process(text: str) -> dict:
    if _cfg.provider == "none":
        return {"result": text, "elapsed_ms": 0, "provider": "none"}
    t0 = time.perf_counter()
    result = process_text(text)
    ms = int((time.perf_counter() - t0) * 1000)
    return {"result": result, "elapsed_ms": ms, "provider": _cfg.provider}
