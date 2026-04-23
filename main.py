import os
import subprocess
import ipaddress
from pathlib import Path

import uvicorn

from api import app

_FALSE_VALUES = {"0", "false", "no", "off"}
_BASE_DIR = Path(__file__).resolve().parent
_DEFAULT_CERTFILE = _BASE_DIR / "certs" / "localhost.crt"
_DEFAULT_KEYFILE = _BASE_DIR / "certs" / "localhost.key"
_DEFAULT_SSL_HOSTS = ("localhost", "127.0.0.1")


def _ssl_enabled() -> bool:
    return os.getenv("ASR_SSL_ENABLED", "1").strip().lower() not in _FALSE_VALUES


def _ssl_force_regenerate() -> bool:
    return os.getenv("ASR_SSL_FORCE_REGENERATE", "0").strip().lower() not in _FALSE_VALUES


def _parse_ssl_hosts() -> list[str]:
    raw_hosts = os.getenv("ASR_SSL_HOSTS")
    if not raw_hosts:
        return list(_DEFAULT_SSL_HOSTS)
    hosts = [item.strip() for item in raw_hosts.split(",") if item.strip()]
    return hosts or list(_DEFAULT_SSL_HOSTS)


def _format_subject_alt_names(hosts: list[str]) -> str:
    san_entries: list[str] = []
    for host in hosts:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            san_entries.append(f"DNS:{host}")
        else:
            san_entries.append(f"IP:{host}")
    return ",".join(san_entries)


def _ssl_common_name(hosts: list[str]) -> str:
    for host in hosts:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return host
    return hosts[0]


def ensure_self_signed_cert(certfile: Path, keyfile: Path) -> None:
    hosts = _parse_ssl_hosts()
    if certfile.exists() and keyfile.exists() and not _ssl_force_regenerate():
        return

    certfile.parent.mkdir(parents=True, exist_ok=True)
    keyfile.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "openssl",
        "req",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-keyout",
        str(keyfile),
        "-out",
        str(certfile),
        "-days",
        os.getenv("ASR_SSL_DAYS", "3650"),
        "-subj",
        f"/CN={_ssl_common_name(hosts)}",
        "-addext",
        f"subjectAltName={_format_subject_alt_names(hosts)}",
    ]

    try:
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("未找到 openssl，无法生成 HTTPS 自签名证书") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError("生成 HTTPS 自签名证书失败") from exc


def get_uvicorn_config() -> dict[str, object]:
    config: dict[str, object] = {
        "host": os.getenv("ASR_HOST", "0.0.0.0"),
        "port": int(os.getenv("ASR_PORT", "9999")),
        "access_log": False,
    }

    if _ssl_enabled():
        certfile = Path(os.getenv("ASR_SSL_CERTFILE", str(_DEFAULT_CERTFILE))).expanduser().resolve()
        keyfile = Path(os.getenv("ASR_SSL_KEYFILE", str(_DEFAULT_KEYFILE))).expanduser().resolve()
        ensure_self_signed_cert(certfile, keyfile)
        config.update({
            "ssl_certfile": str(certfile),
            "ssl_keyfile": str(keyfile),
        })

    return config


def main() -> None:
    uvicorn.run(app, **get_uvicorn_config())


if __name__ == "__main__":
    main()
