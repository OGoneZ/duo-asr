import main


def test_main_passes_config_to_uvicorn(monkeypatch):
    captured: dict[str, object] = {}
    sentinel_app = object()

    monkeypatch.setattr(main, "app", sentinel_app)
    monkeypatch.setattr(main.config, "HOST", "127.0.0.1")
    monkeypatch.setattr(main.config, "PORT", 9443)

    def fake_run(app, **kwargs):
        captured["app"] = app
        captured.update(kwargs)

    monkeypatch.setattr(main.uvicorn, "run", fake_run)

    main.main()

    assert captured == {
        "app": sentinel_app,
        "host": "127.0.0.1",
        "port": 9443,
        "access_log": False,
    }
