class ASRServerError(RuntimeError):
    """服务可恢复错误的基类。"""


class ModelLoadError(ASRServerError):
    """模型加载失败时抛出。"""


class TranscriptionError(ASRServerError):
    """模型推理失败或返回无效输出时抛出。"""


class PostProcessError(ASRServerError):
    """后处理意外失败时抛出。"""
