from pathlib import Path

import torch


_REPO_ROOT = Path(__file__).parent.parent

# 模型
MODELS_DIR = _REPO_ROOT / "models"
MODEL_NAME = "Qwen3-ASR-1.7B"  # 当前激活模型，3d 阶段做持久化切换
MODEL_PATH = MODELS_DIR / MODEL_NAME


def _auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEVICE = _auto_device()  # 想强制指定可直接改成 "cuda" / "mps" / "cpu"
DTYPE = torch.float16    # torch.float16 / torch.bfloat16 / torch.float32

# HTTP
HOST = "0.0.0.0"
PORT = 9999

# 访问白名单
ALLOWED_IPS = {"127.0.0.1", "::1"}
ALLOWED_IP_PREFIXES = ("10.0.0.",)

# 日志
LOG_LEVEL = "INFO"
LOG_DIR = _REPO_ROOT / "logs"

# 数据持久化
DATA_DIR = _REPO_ROOT / "data"
DB_PATH = DATA_DIR / "asr.db"
RECORDINGS_DIR = _REPO_ROOT / "recordings"

# 静态资源（dashboard 前端）
STATIC_DIR = _REPO_ROOT / "static"

# 热词词典（运行时可热更新）
HOTWORDS_FILE = _REPO_ROOT / "hotwords.toml"
