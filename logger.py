import logging
from pathlib import Path
from datetime import datetime

import config


class DailyLogHandler(logging.Handler):
    """
    动态日志 handler，按月分目录，每天一个日志文件。
    日志文件路径: <log_dir>/YYYY-MM/YYYY-MM-DD.log
    """

    def __init__(self, log_dir: Path, level: int):
        super().__init__()
        self.log_dir = log_dir
        self.file_level = level
        self.last_date = None
        self.handler = None

    def _ensure_handler(self):
        today = datetime.now().strftime("%Y-%m-%d")
        if today != self.last_date or self.handler is None:
            if self.handler:
                self.handler.close()

            year_month = datetime.now().strftime("%Y-%m")
            month_dir = self.log_dir / year_month
            month_dir.mkdir(parents=True, exist_ok=True)

            log_file = month_dir / f"{today}.log"

            self.handler = logging.FileHandler(log_file, encoding="utf-8")
            self.handler.setLevel(self.file_level)
            self.handler.setFormatter(logging.Formatter(
                "%(asctime)s %(levelname)s %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S"
            ))
            self.last_date = today

    def emit(self, record):
        self._ensure_handler()
        self.handler.emit(record)


def setup_logger(name: str = None):
    """
    设置日志，同时输出到控制台和按月分目录的日志文件。
    """
    level = logging.getLevelNamesMapping().get(config.LOG_LEVEL, logging.INFO)

    # 清理 root handlers
    for handler in logging.root.handlers[:]:
        logging.root.removeHandler(handler)

    # 清理目标 logger 上的旧 handlers
    logger = logging.getLogger(name)
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)

    # 控制台 handler
    console = logging.StreamHandler()
    console.setLevel(level)
    console.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    ))

    # 动态文件 handler
    file_handler = DailyLogHandler(config.LOG_DIR, level)

    logger.addHandler(console)
    logger.addHandler(file_handler)
    logger.propagate = False
    logger.setLevel(level)

    return logger
