"""后处理模型管理 + 推理（singleton）。

三种 provider 模式:
  - "none":     透传，不做任何处理
  - "local":    进程内 llama-cpp-python 加载 GGUF，零 HTTP 开销
  - "endpoint": OpenAI-compatible /v1/chat/completions

模块职责：配置持久化、模型生命周期、文本清理。
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

# ── 模块级单例 ──────────────────────────────────────────
_llm = None  # llama_cpp.Llama 实例（local 模式）
_load_lock = threading.Lock()

# ── HTTP client（endpoint 模式复用） ─────────────────────
_http: httpx.Client | None = None


def _get_http() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=30.0)
    return _http


# ── 配置管理 ─────────────────────────────────────────────


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


_cfg = _Config(
    provider="none",
    model_name="",
    endpoint_url="",
    endpoint_key="",
    endpoint_model="",
    prompt="",
)


def _sync_config_from_module() -> None:
    """启动时把 config.py 的初始值同步到内存。"""
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
    """把内存配置推回 config.py 模块级变量。"""
    config.POST_PROCESS_PROVIDER = _cfg.provider
    config.POST_PROCESS_MODEL_NAME = _cfg.model_name
    config.POST_PROCESS_ENDPOINT_URL = _cfg.endpoint_url
    config.POST_PROCESS_ENDPOINT_KEY = _cfg.endpoint_key
    config.POST_PROCESS_ENDPOINT_MODEL = _cfg.endpoint_model
    config.POST_PROCESS_PROMPT = _cfg.prompt


def restore_config_from_disk() -> None:
    """启动时调用：从 JSON 恢复配置，覆盖 config.py 默认值。"""
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
    """持久化当前配置到 JSON 文件。"""
    cfg_file = config.POST_PROCESS_CONFIG_FILE
    cfg_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg_file.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(_cfg.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(cfg_file)


def get_config() -> dict:
    """返回当前配置（key 脱敏），附带本地可用 GGUF 列表。"""
    from app.models_registry import list_gguf_models

    prompt = _cfg.prompt or config.POST_PROCESS_PROMPT
    d = _cfg.to_dict(mask_key=True)
    d["prompt"] = prompt
    d["local_models"] = list_gguf_models()
    return d


def update_config(data: dict) -> dict:
    """更新配置并持久化。触发 local 模型 re-load（如需要）。

    endpoint_key 为 "***" 开头占位符时保留旧值不变。
    """
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
    """解析当前激活的 GGUF 模型路径。"""
    if not _cfg.model_name:
        return None
    p = config.MODELS_DIR / _cfg.model_name
    if p.is_file():
        return p
    return None


def _load_local_model() -> None:
    """加载 GGUF 模型到进程内存（singleton）。"""
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
        logger.error("llama-cpp-python 未安装，无法加载本地模型")
        return
    logger.info("加载后处理模型: %s", model_path)
    try:
        _llm = Llama(
            model_path=str(model_path),
            n_gpu_layers=-1,
            n_ctx=2048,
            verbose=False,
        )
    except Exception:
        logger.exception("后处理模型加载失败: %s", model_path)
        _llm = None
        return
    logger.info("后处理模型加载完成")


def _unload_local_model() -> None:
    """释放 llama.cpp 模型。"""
    global _llm
    old = _llm
    _llm = None
    del old
    gc.collect()


def _handle_reload() -> None:
    """根据当前 provider 决定是否需要加载/卸载模型。"""
    with _load_lock:
        if _cfg.provider == "local":
            _unload_local_model()
            _load_local_model()
        else:
            _unload_local_model()


def switch_model(name: str) -> None:
    """切换激活的本地 GGUF 模型。"""
    target = config.MODELS_DIR / name
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
    """对转录文本进行 LLM 后处理。

    根据 provider 选择处理方式。异常时 fallback 返回原文本，不阻断转录流程。
    """
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
    """llama-cpp-python 进程内推理。"""
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
    """调用自定义 OpenAI-compatible endpoint。"""
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
    # 抑制 DeepSeek 等模型的思考模式
    payload["reasoning_effort"] = "none"  # type: ignore[typeddict-unknown-key]
    http = _get_http()
    resp = http.post(f"{url}/v1/chat/completions", json=payload, headers=headers)
    resp.raise_for_status()
    result = resp.json()["choices"][0]["message"]["content"]
    return result.strip() if result else text


def test_process(text: str) -> dict:
    """测试接口：返回清理结果 + 耗时。"""
    if _cfg.provider == "none":
        return {"result": text, "elapsed_ms": 0, "provider": "none"}
    t0 = time.perf_counter()
    result = process_text(text)
    ms = int((time.perf_counter() - t0) * 1000)
    return {"result": result, "elapsed_ms": ms, "provider": _cfg.provider}
