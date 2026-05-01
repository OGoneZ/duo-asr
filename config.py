from pathlib import Path

import torch


_REPO_ROOT = Path(__file__).parent

# 模型
MODEL_PATH = _REPO_ROOT / "models" / "Qwen3-ASR-1.7B"


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
