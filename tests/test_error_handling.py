import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.requests import Request

import api
import hot_reload
import model
from errors import ModelLoadError, PostProcessError, TranscriptionError


def _make_request(path: str = "/v1/audio/transcriptions", method: str = "POST") -> Request:
    return Request({
        "type": "http",
        "method": method,
        "path": path,
        "headers": [],
        "scheme": "http",
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 12345),
    })


def test_service_error_handler_returns_json():
    response = asyncio.run(api.handle_service_error(_make_request(), TranscriptionError("模型推理失败: demo.wav")))

    assert response.status_code == 500
    assert json.loads(response.body) == {"error": "模型推理失败: demo.wav"}


def test_model_load_error_handler_returns_503():
    response = asyncio.run(api.handle_service_error(_make_request(), ModelLoadError("模型加载失败: mock")))

    assert response.status_code == 503
    assert json.loads(response.body) == {"error": "模型加载失败: mock"}


def test_validation_error_handler_returns_details():
    exc = RequestValidationError([{"loc": ("body", "file"), "msg": "Field required", "type": "missing"}])
    response = asyncio.run(api.handle_validation_error(_make_request(), exc))

    assert response.status_code == 422
    assert b'"error":"Invalid request"' in response.body
    assert b'"loc":["body","file"]' in response.body


def test_http_error_handler_returns_json():
    response = asyncio.run(api.handle_http_error(_make_request(method="GET"), HTTPException(status_code=403, detail="Forbidden")))

    assert response.status_code == 403
    assert response.body == b'{"error":"Forbidden"}'


def test_unexpected_error_handler_returns_generic_json():
    response = asyncio.run(api.handle_unexpected_error(_make_request(), RuntimeError("boom")))

    assert response.status_code == 500
    assert response.body == b'{"error":"Internal server error"}'


def test_load_model_wraps_failure(monkeypatch):
    monkeypatch.setattr(model, "_model", None)

    def fake_from_pretrained(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(model.Qwen3ASRModel, "from_pretrained", fake_from_pretrained)

    with pytest.raises(ModelLoadError, match="模型加载失败"):
        model.load_model()


def test_transcribe_wraps_inference_failure(monkeypatch):
    class BrokenModel:
        def transcribe(self, audio_path, language=None):
            raise RuntimeError("boom")

    monkeypatch.setattr(model, "load_model", lambda: BrokenModel())

    with pytest.raises(TranscriptionError, match="模型推理失败"):
        model.transcribe("demo.wav")


def test_transcribe_rejects_empty_results(monkeypatch):
    class EmptyResultModel:
        def transcribe(self, audio_path, language=None):
            return []

    monkeypatch.setattr(model, "load_model", lambda: EmptyResultModel())

    with pytest.raises(TranscriptionError, match="模型推理返回空结果"):
        model.transcribe("demo.wav")


def test_transcribe_wraps_post_process_failure(monkeypatch):
    class SuccessModel:
        def transcribe(self, audio_path, language=None):
            return [SimpleNamespace(text="raw text")]

    monkeypatch.setattr(model, "load_model", lambda: SuccessModel())
    monkeypatch.setattr(hot_reload, "normalize_numbers", lambda text: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(PostProcessError, match="后处理失败"):
        model.transcribe("demo.wav")


@pytest.mark.parametrize(("client_ip", "allowed"), [
    ("127.0.0.1", True),
    ("::1", True),
    ("10.0.0.4", True),
    ("10.0.1.4", False),
])
def test_allowed_client_ip_ranges(client_ip, allowed):
    assert api._is_allowed_client_ip(client_ip) is allowed
