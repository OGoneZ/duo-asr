"""统一异常处理。"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.errors import ASRServerError, ModelLoadError
from app.logger import setup_logger

logger = setup_logger(__name__)


def _request_label(request: Request) -> str:
    return f"{request.method} {request.url.path}"


async def handle_service_error(request: Request, exc: ASRServerError):
    status_code = 503 if isinstance(exc, ModelLoadError) else 500
    return JSONResponse({"error": str(exc)}, status_code=status_code)


async def handle_validation_error(request: Request, exc: RequestValidationError):
    logger.warning("请求参数校验失败: %s, errors=%s", _request_label(request), exc.errors())
    return JSONResponse({"error": "Invalid request", "details": exc.errors()}, status_code=422)


async def handle_http_error(request: Request, exc: HTTPException):
    log_method = logger.warning if exc.status_code < 500 else logger.error
    log_method("HTTP异常: %s, status=%s, detail=%s", _request_label(request), exc.status_code, exc.detail)
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


async def handle_unexpected_error(request: Request, exc: Exception):
    logger.exception("未处理异常: %s", _request_label(request))
    return JSONResponse({"error": "Internal server error"}, status_code=500)


def register(app: FastAPI) -> None:
    app.add_exception_handler(ASRServerError, handle_service_error)
    app.add_exception_handler(RequestValidationError, handle_validation_error)
    app.add_exception_handler(HTTPException, handle_http_error)
    app.add_exception_handler(Exception, handle_unexpected_error)
