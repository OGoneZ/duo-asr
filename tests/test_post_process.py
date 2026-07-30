"""后处理模型模块单元测试。"""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app import config, post_process_model


# ── helpers ────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    """每个测试前重置模块单例状态。"""
    monkeypatch.setattr(post_process_model, "_llm", None)
    monkeypatch.setattr(post_process_model, "_cfg", post_process_model._Config())
    monkeypatch.setattr(config, "POST_PROCESS_PROVIDER", "none")
    monkeypatch.setattr(config, "POST_PROCESS_MODEL_NAME", "")
    monkeypatch.setattr(config, "POST_PROCESS_ENDPOINT_URL", "")
    monkeypatch.setattr(config, "POST_PROCESS_ENDPOINT_KEY", "")
    monkeypatch.setattr(config, "POST_PROCESS_ENDPOINT_MODEL", "")
    monkeypatch.setattr(config, "POST_PROCESS_PROMPT", "test default prompt")


@pytest.fixture
def _mock_list_llm(monkeypatch):
    monkeypatch.setattr("app.models_registry.list_llm_models", lambda: [])


# ── config: get / update ────────────────────────────


class TestGetConfig:
    def test_defaults_to_none_provider(self, _mock_list_llm):
        cfg = post_process_model.get_config()
        assert cfg["provider"] == "none"
        assert cfg["model_name"] == ""
        assert cfg["endpoint_url"] == ""
        assert cfg["local_models"] == []

    def test_returns_default_prompt_when_not_configured(self, _mock_list_llm):
        cfg = post_process_model.get_config()
        assert cfg["prompt"] == "test default prompt"

    def test_masks_endpoint_key(self, _mock_list_llm):
        post_process_model.update_config({"endpoint_key": "sk-abcdefgh12345678"})
        cfg = post_process_model.get_config()
        assert cfg["endpoint_key"] == "***5678"

    def test_short_key_masks_correctly(self, _mock_list_llm):
        post_process_model.update_config({"endpoint_key": "abc"})
        cfg = post_process_model.get_config()
        assert cfg["endpoint_key"] == "***abc"


class TestUpdateConfig:
    def test_update_provider(self):
        post_process_model.update_config({"provider": "endpoint"})
        assert post_process_model._cfg.provider == "endpoint"
        assert config.POST_PROCESS_PROVIDER == "endpoint"

    def test_update_endpoint_fields(self):
        post_process_model.update_config(
            {
                "endpoint_url": "https://api.example.com/v1",
                "endpoint_model": "gpt-4o",
            }
        )
        cfg = post_process_model.get_config()
        assert cfg["endpoint_url"] == "https://api.example.com/v1"
        assert cfg["endpoint_model"] == "gpt-4o"

    def test_update_prompt(self):
        post_process_model.update_config({"prompt": "custom prompt"})
        cfg = post_process_model.get_config()
        assert cfg["prompt"] == "custom prompt"

    def test_key_placeholder_preserves_old_value(self):
        post_process_model.update_config({"endpoint_key": "sk-real-key-1234"})
        post_process_model.update_config({"endpoint_key": "***5678"})
        assert post_process_model._cfg.endpoint_key == "sk-real-key-1234"

    def test_rejects_invalid_provider(self):
        with pytest.raises(ValueError, match="非法的 provider"):
            post_process_model.update_config({"provider": "invalid"})


# ── config: disk persistence ────────────────────────


class TestDiskPersistence:
    def test_roundtrip(self, monkeypatch, tmp_path: Path):
        cfg_file = tmp_path / "post_process_config.json"
        monkeypatch.setattr(config, "POST_PROCESS_CONFIG_FILE", cfg_file)
        post_process_model.update_config(
            {
                "provider": "endpoint",
                "endpoint_url": "https://api.example.com/v1",
                "endpoint_key": "sk-secret-1234",
                "endpoint_model": "gpt-4o",
                "prompt": "my prompt",
            }
        )
        assert cfg_file.is_file()
        post_process_model._cfg = post_process_model._Config()
        post_process_model.restore_config_from_disk()
        assert post_process_model._cfg.provider == "endpoint"
        assert post_process_model._cfg.endpoint_url == "https://api.example.com/v1"
        assert post_process_model._cfg.endpoint_key == "sk-secret-1234"
        assert post_process_model._cfg.endpoint_model == "gpt-4o"
        assert post_process_model._cfg.prompt == "my prompt"

    def test_restore_when_no_file(self, monkeypatch, tmp_path: Path):
        monkeypatch.setattr(
            config, "POST_PROCESS_CONFIG_FILE", tmp_path / "nonexistent.json"
        )
        post_process_model._cfg = post_process_model._Config()
        post_process_model.restore_config_from_disk()
        assert post_process_model._cfg.provider == "none"

    def test_restore_corrupted_file(self, monkeypatch, tmp_path: Path):
        bad = tmp_path / "corrupted.json"
        bad.write_text("{not valid json!!!}")
        monkeypatch.setattr(config, "POST_PROCESS_CONFIG_FILE", bad)
        post_process_model._cfg = post_process_model._Config(provider="endpoint")
        post_process_model.restore_config_from_disk()
        assert post_process_model._cfg.provider == "none"


# ── process_text ───────────────────────────────────


class TestProcessText:
    def test_none_provider_passthrough(self):
        post_process_model._cfg.provider = "none"
        assert post_process_model.process_text("hello world") == "hello world"

    def test_empty_text_passthrough(self):
        post_process_model._cfg.provider = "endpoint"
        assert post_process_model.process_text("") == ""
        assert post_process_model.process_text("   ") == "   "

    def test_endpoint_success(self, monkeypatch):
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = "https://api.example.com"
        post_process_model._cfg.endpoint_key = "sk-test"
        post_process_model._cfg.endpoint_model = "test-model"
        post_process_model._cfg.prompt = "clean it"
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "cleaned text"}}]
        }
        mock_http.post.return_value = mock_resp
        monkeypatch.setattr(post_process_model, "_http", mock_http)
        assert post_process_model.process_text("raw text") == "cleaned text"

    def test_endpoint_error_fallback(self, monkeypatch):
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = "https://api.example.com"
        post_process_model._cfg.prompt = "clean it"
        mock_http = MagicMock()
        mock_http.post.side_effect = RuntimeError("connection refused")
        monkeypatch.setattr(post_process_model, "_http", mock_http)
        assert post_process_model.process_text("raw text") == "raw text"

    def test_endpoint_empty_url_fallback(self):
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = ""
        assert post_process_model.process_text("raw text") == "raw text"

    def test_no_prompt_fallback(self, monkeypatch):
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = "https://api.example.com"
        post_process_model._cfg.prompt = ""
        monkeypatch.setattr(config, "POST_PROCESS_PROMPT", "")
        assert post_process_model.process_text("raw text") == "raw text"

    def test_empty_endpoint_result_strips_whitespace(self, monkeypatch):
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "  clean  "}}]
        }
        mock_http.post.return_value = mock_resp
        monkeypatch.setattr(post_process_model, "_http", mock_http)
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = "https://api.example.com"
        post_process_model._cfg.prompt = "clean it"
        assert post_process_model.process_text("raw") == "clean"


class TestProcessTextLocal:
    def test_model_not_loaded_fallback(self):
        post_process_model._cfg.provider = "local"
        post_process_model._cfg.model_name = "test-model"
        # _model is None by default (from _reset_state)
        assert post_process_model.process_text("hello") == "hello"


# ── test_process ────────────────────────────────────


class TestTestProcess:
    def test_none_provider(self):
        r = post_process_model.test_process("hello")
        assert r == {"result": "hello", "elapsed_ms": 0, "provider": "none"}

    def test_endpoint(self, monkeypatch):
        mock_http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"choices": [{"message": {"content": "cleaned"}}]}
        mock_http.post.return_value = mock_resp
        monkeypatch.setattr(post_process_model, "_http", mock_http)
        post_process_model._cfg.provider = "endpoint"
        post_process_model._cfg.endpoint_url = "https://api.example.com"
        post_process_model._cfg.prompt = "clean it"
        r = post_process_model.test_process("raw")
        assert r["result"] == "cleaned"
        assert r["elapsed_ms"] >= 0
        assert r["provider"] == "endpoint"


# ── switch_model ────────────────────────────────────


class TestSwitchModel:
    def test_file_not_found(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr(config, "LLM_MODELS_DIR", tmp_path)
        with pytest.raises(FileNotFoundError):
            post_process_model.switch_model("nonexistent.gguf")

    def test_switch_updates_config(self, tmp_path: Path, monkeypatch):
        gf = tmp_path / "test.gguf"
        gf.write_bytes(b"mock")
        monkeypatch.setattr(config, "LLM_MODELS_DIR", tmp_path)

        def fake_load():
            pass

        monkeypatch.setattr(post_process_model, "_load_local_model", fake_load)
        post_process_model.switch_model("test.gguf")
        assert post_process_model._cfg.model_name == "test.gguf"
        assert config.POST_PROCESS_MODEL_NAME == "test.gguf"


class TestListLlmModels:
    def test_empty_dir(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr(config, "LLM_MODELS_DIR", tmp_path)
        from app.models_registry import list_llm_models

        assert list_llm_models() == []

    def test_scans_gguf_files(self, tmp_path: Path, monkeypatch):
        (tmp_path / "model-a.gguf").write_bytes(b"x" * 100)
        (tmp_path / "model-b.gguf").write_bytes(b"y" * 200)
        (tmp_path / "not-a-model.txt").write_text("nope")
        monkeypatch.setattr(config, "LLM_MODELS_DIR", tmp_path)
        from app.models_registry import list_llm_models

        models = list_llm_models()
        names = {m["name"] for m in models}
        assert names == {"model-a.gguf", "model-b.gguf"}

    def test_marks_current_model(self, tmp_path: Path, monkeypatch):
        (tmp_path / "active.gguf").write_bytes(b"data")
        (tmp_path / "inactive.gguf").write_bytes(b"data")
        monkeypatch.setattr(config, "LLM_MODELS_DIR", tmp_path)
        monkeypatch.setattr(config, "POST_PROCESS_MODEL_NAME", "active.gguf")
        from app.models_registry import list_llm_models

        models = {m["name"]: m["is_current"] for m in list_llm_models()}
        assert models["active.gguf"] is True
        assert models["inactive.gguf"] is False
