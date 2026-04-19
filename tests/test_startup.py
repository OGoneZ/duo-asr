from fastapi.testclient import TestClient

import api


def test_model_preloads_on_startup(monkeypatch):
    calls: list[str] = []

    def fake_load_model():
        calls.append("loaded")
        return object()

    monkeypatch.setattr(api.model, "load_model", fake_load_model)

    with TestClient(api.app):
        assert calls == ["loaded"]
