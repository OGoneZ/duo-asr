import os

import uvicorn

from api import app


def get_uvicorn_config() -> dict[str, object]:
    return {
        "host": os.getenv("ASR_HOST", "0.0.0.0"),
        "port": int(os.getenv("ASR_PORT", "9999")),
        "access_log": False,
    }


def main() -> None:
    uvicorn.run(app, **get_uvicorn_config())


if __name__ == "__main__":
    main()
