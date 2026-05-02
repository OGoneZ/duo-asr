"""IP 白名单中间件 + 反向代理 peer 解析。"""
from __future__ import annotations

import asyncio
import socket
import time

from fastapi import Request
from fastapi.responses import JSONResponse

from app import config
from app.logger import setup_logger

logger = setup_logger(__name__)

_PTR_CACHE_TTL_SECONDS = 300
_ptr_cache: dict[str, tuple[str, float]] = {}


def is_allowed_client_ip(client_ip: str) -> bool:
    if client_ip in config.ALLOWED_IPS:
        return True
    return any(client_ip.startswith(prefix) for prefix in config.ALLOWED_IP_PREFIXES)


def get_real_client_ip(request: Request) -> str:
    # 走 Caddy 反代时 request.client.host 是 Caddy 的 10.0.0.1，
    # 真正的 peer IP 在 X-Forwarded-For 里（Caddy 默认会加）。
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host


async def resolve_peer_name(ip: str) -> str:
    if ip in {"127.0.0.1", "::1"}:
        return "local"
    now = time.time()
    cached = _ptr_cache.get(ip)
    if cached and cached[1] > now:
        return cached[0]
    try:
        host, _, _ = await asyncio.to_thread(socket.gethostbyaddr, ip)
        name = host.removesuffix(".").removesuffix(".wg") or ip
    except (OSError, socket.herror):
        name = ip
    _ptr_cache[ip] = (name, now + _PTR_CACHE_TTL_SECONDS)
    return name


def format_client(name: str, ip: str) -> str:
    return ip if name == ip else f"{name} ({ip})"


async def restrict_ip(request: Request, call_next):
    """只允许 10.0.0.0/24 网段和本地访问。"""
    client_ip = get_real_client_ip(request)
    if not is_allowed_client_ip(client_ip):
        logger.warning(f"拒绝非授权网段访问: {client_ip}")
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    client_host = await resolve_peer_name(client_ip)
    request.state.client_ip = client_ip
    request.state.client_host = client_host
    logger.info(f"请求来源: {format_client(client_host, client_ip)}")
    return await call_next(request)
