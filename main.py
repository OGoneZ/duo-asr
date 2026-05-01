import uvicorn

import config
from api import app


def main() -> None:
    uvicorn.run(app, host=config.HOST, port=config.PORT, access_log=False)


if __name__ == "__main__":
    main()
