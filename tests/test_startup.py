import pytest
from fastapi.testclient import TestClient

from app import api
from app.errors import ModelLoadError


def test_model_preloads_on_startup(monkeypatch):
    calls: list[str] = []

    def fake_load_model():
        calls.append("loaded")
        return object()

    monkeypatch.setattr(api.model, "load_model", fake_load_model)

    with TestClient(api.app):
        assert calls == ["loaded"]


def test_startup_fails_when_model_preload_errors(monkeypatch):
    def fake_load_model():
        raise ModelLoadError("模型加载失败: mock")

    monkeypatch.setattr(api.model, "load_model", fake_load_model)

    with pytest.raises(ModelLoadError, match="模型加载失败"):
        with TestClient(api.app):
            pass
