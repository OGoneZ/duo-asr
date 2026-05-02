"""ModelScope 模型搜索代理。

ModelScope 公开搜索 endpoint：
  PUT https://modelscope.cn/api/v1/models/  (注意尾斜杠，否则 307)
  body: {"Name": "<keyword>", "PageNumber": 1, "PageSize": 20}

Tasks 字段当过滤器无效（已踩坑），靠关键词模糊匹配。我们这里只做"关键词搜
索 + 结果整形 + 已下载状态联表"，不试图改变 ModelScope 的过滤行为。

带轻量内存缓存（关键词+page 维度，TTL 60s），避免相同搜索反复打公网。
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.logger import setup_logger

logger = setup_logger(__name__)

_ENDPOINT = "https://modelscope.cn/api/v1/models/"
_TIMEOUT = 10.0
_CACHE_TTL = 60.0
_CACHE_MAX = 64

# (query, page, page_size) -> (expires_at, response_dict)
_cache: dict[tuple[str, int, int], tuple[float, dict[str, Any]]] = {}


def _is_asr_task(tasks: list[dict]) -> bool:
    """根据 ModelScope 返回的 Tasks 列表判断是否为 ASR 模型。"""
    keywords = ("auto-speech-recognition", "asr", "speech")
    for t in tasks or []:
        name = (t.get("Name") or "").lower()
        domain = (t.get("DomainName") or "").lower()
        cn = (t.get("ChineseName") or "").lower()
        if any(k in name for k in keywords):
            return True
        if domain == "audio" and ("识别" in cn or "asr" in cn):
            return True
    return False


def _shape_model(m: dict) -> dict | None:
    path = (m.get("Path") or "").strip()
    name = (m.get("Name") or "").strip()
    if not path or not name:
        return None
    tasks = m.get("Tasks") or []
    task_names = sorted({(t.get("Name") or "") for t in tasks if t.get("Name")})
    return {
        "model_id": f"{path}/{name}",
        "path": path,
        "name": name,
        "chinese_name": (m.get("ChineseName") or "").strip(),
        "downloads": m.get("Downloads", 0),
        "stars": m.get("Stars", 0),
        "tasks": task_names,
        "is_asr": _is_asr_task(tasks),
    }


async def search(query: str, page: int = 1, page_size: int = 20) -> dict[str, Any]:
    """关键词搜索 ModelScope 模型库。返回 ``{query, page, page_size, total, items}``。"""
    query = (query or "").strip()
    if not query:
        return {"query": "", "page": page, "page_size": page_size, "total": 0, "items": []}

    cache_key = (query, page, page_size)
    now = time.time()
    hit = _cache.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            r = await client.put(
                _ENDPOINT,
                json={"Name": query, "PageNumber": page, "PageSize": page_size},
            )
    except httpx.HTTPError as exc:
        logger.warning("ModelScope 搜索失败: %s", exc)
        raise RuntimeError(f"ModelScope 请求失败: {exc}") from exc

    if r.status_code != 200:
        raise RuntimeError(f"ModelScope 返回 {r.status_code}")

    body = r.json()
    if body.get("Code") not in (200, None):
        raise RuntimeError(f"ModelScope 业务码 {body.get('Code')}: {body.get('Message')}")

    data = body.get("Data") or {}
    raw_models = data.get("Models") or []
    items = [m for m in (_shape_model(m) for m in raw_models) if m is not None]

    result = {
        "query": query,
        "page": page,
        "page_size": page_size,
        "total": data.get("TotalCount") or 0,
        "items": items,
    }

    # 缓存（简单 LRU：超量时丢最早过期的一项）
    if len(_cache) >= _CACHE_MAX:
        oldest = min(_cache.items(), key=lambda kv: kv[1][0])
        _cache.pop(oldest[0], None)
    _cache[cache_key] = (now + _CACHE_TTL, result)
    return result
