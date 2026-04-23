import main


def test_get_uvicorn_config_defaults(monkeypatch):
    monkeypatch.delenv("ASR_HOST", raising=False)
    monkeypatch.delenv("ASR_PORT", raising=False)

    config = main.get_uvicorn_config()

    assert config == {
        "host": "0.0.0.0",
        "port": 9999,
        "access_log": False,
    }


def test_get_uvicorn_config_reads_env(monkeypatch):
    monkeypatch.setenv("ASR_HOST", "127.0.0.1")
    monkeypatch.setenv("ASR_PORT", "8080")

    config = main.get_uvicorn_config()

    assert config["host"] == "127.0.0.1"
    assert config["port"] == 8080


def test_main_passes_config_to_uvicorn(monkeypatch):
    captured: dict[str, object] = {}
    sentinel_app = object()

    monkeypatch.setattr(main, "app", sentinel_app)
    monkeypatch.setattr(main, "get_uvicorn_config", lambda: {"host": "127.0.0.1", "port": 9443})

    def fake_run(app, **kwargs):
        captured["app"] = app
        captured.update(kwargs)

    monkeypatch.setattr(main.uvicorn, "run", fake_run)

    main.main()

    assert captured == {"app": sentinel_app, "host": "127.0.0.1", "port": 9443}
