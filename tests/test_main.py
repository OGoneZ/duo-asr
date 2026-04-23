import main


def test_ensure_self_signed_cert_generates_files(tmp_path):
    certfile = tmp_path / "localhost.crt"
    keyfile = tmp_path / "localhost.key"

    main.ensure_self_signed_cert(certfile, keyfile)

    assert certfile.exists()
    assert keyfile.exists()
    assert certfile.read_text(encoding="utf-8").startswith("-----BEGIN CERTIFICATE-----")
    assert keyfile.read_text(encoding="utf-8").startswith("-----BEGIN PRIVATE KEY-----")


def test_format_subject_alt_names_supports_dns_and_ip():
    sans = main._format_subject_alt_names(["localhost", "127.0.0.1", "10.0.0.4"])

    assert sans == "DNS:localhost,IP:127.0.0.1,IP:10.0.0.4"


def test_parse_ssl_hosts_reads_custom_hosts(monkeypatch):
    monkeypatch.setenv("ASR_SSL_HOSTS", "localhost,127.0.0.1,10.0.0.4")

    assert main._parse_ssl_hosts() == ["localhost", "127.0.0.1", "10.0.0.4"]


def test_get_uvicorn_config_enables_https_by_default(tmp_path, monkeypatch):
    certfile = tmp_path / "localhost.crt"
    keyfile = tmp_path / "localhost.key"

    monkeypatch.delenv("ASR_SSL_ENABLED", raising=False)
    monkeypatch.setenv("ASR_SSL_CERTFILE", str(certfile))
    monkeypatch.setenv("ASR_SSL_KEYFILE", str(keyfile))

    config = main.get_uvicorn_config()

    assert config["host"] == "0.0.0.0"
    assert config["port"] == 9999
    assert config["ssl_certfile"] == str(certfile.resolve())
    assert config["ssl_keyfile"] == str(keyfile.resolve())


def test_get_uvicorn_config_reuses_custom_hosts(tmp_path, monkeypatch):
    certfile = tmp_path / "localhost.crt"
    keyfile = tmp_path / "localhost.key"

    monkeypatch.setenv("ASR_SSL_CERTFILE", str(certfile))
    monkeypatch.setenv("ASR_SSL_KEYFILE", str(keyfile))
    monkeypatch.setenv("ASR_SSL_HOSTS", "localhost,127.0.0.1,10.0.0.4")
    monkeypatch.setenv("ASR_SSL_FORCE_REGENERATE", "1")

    config = main.get_uvicorn_config()

    assert config["ssl_certfile"] == str(certfile.resolve())
    assert config["ssl_keyfile"] == str(keyfile.resolve())


def test_get_uvicorn_config_can_disable_https(monkeypatch):
    monkeypatch.setenv("ASR_SSL_ENABLED", "0")

    config = main.get_uvicorn_config()

    assert "ssl_certfile" not in config
    assert "ssl_keyfile" not in config


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
