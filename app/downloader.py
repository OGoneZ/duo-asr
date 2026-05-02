"""Modelscope 异步下载任务管理。

设计要点：
- 进程内字典管理 task_id → DownloadTask 状态
- 单线程串行下载（同一时刻最多 1 个任务在跑），避免磁盘/带宽抢占
- 进度通过 ProgressCallback 子类回写 task，前端 polling 取
- 用户可以注册新任务、查询任意任务状态；不实现"取消"（modelscope 不暴露中断）
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Type

from modelscope import snapshot_download
from modelscope.hub.callback import ProgressCallback

from app import config
from app.logger import setup_logger

logger = setup_logger(__name__)


@dataclass
class DownloadTask:
    task_id: str
    model_id: str            # modelscope 上的完整 id，如 "iic/SenseVoiceSmall"
    target_name: str         # 本地落点 models/<target_name>/
    state: str = "queued"    # queued / running / done / error
    error: str | None = None
    started_at: float | None = None
    ended_at: float | None = None
    files: dict[str, dict] = field(default_factory=dict)   # filename → {size, downloaded}
    overall_bytes: int = 0           # 已下载字节累加
    overall_total: int = 0           # 估计总字节（callback 注册时累加）
    lock: threading.Lock = field(default_factory=threading.Lock)

    def to_dict(self) -> dict:
        with self.lock:
            files_summary = [
                {
                    "name": fn,
                    "size": meta["size"],
                    "downloaded": meta["downloaded"],
                    "done": meta["downloaded"] >= meta["size"],
                }
                for fn, meta in self.files.items()
            ]
            return {
                "task_id": self.task_id,
                "model_id": self.model_id,
                "target_name": self.target_name,
                "state": self.state,
                "error": self.error,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "files": files_summary,
                "files_done": sum(1 for f in files_summary if f["done"]),
                "files_total": len(files_summary),
                "bytes_done": self.overall_bytes,
                "bytes_total": self.overall_total,
                "percent": (
                    round(100 * self.overall_bytes / self.overall_total, 1)
                    if self.overall_total > 0 else 0
                ),
            }


_tasks: dict[str, DownloadTask] = {}
_tasks_lock = threading.Lock()
_run_lock = threading.Lock()    # 串行化实际下载


def _make_callback_class(task: DownloadTask) -> Type[ProgressCallback]:
    """返回一个绑定 task 的 ProgressCallback 子类（modelscope 期待类型，不是实例）。"""
    class _TaskCb(ProgressCallback):
        def __init__(self, filename: str, file_size: int):
            super().__init__(filename, file_size)
            with task.lock:
                # 同名文件第一次注册时累加，后续重复回调不重复加
                if filename not in task.files:
                    task.files[filename] = {"size": file_size, "downloaded": 0}
                    task.overall_total += file_size
            self._filename = filename

        def update(self, size: int):
            with task.lock:
                meta = task.files.get(self._filename)
                if meta is not None:
                    meta["downloaded"] += size
                    task.overall_bytes += size

        def end(self):
            with task.lock:
                meta = task.files.get(self._filename)
                if meta is not None and meta["downloaded"] < meta["size"]:
                    # 校正：modelscope 偶尔不严格累加到 file_size，强制对齐避免 100% 卡住
                    delta = meta["size"] - meta["downloaded"]
                    meta["downloaded"] = meta["size"]
                    task.overall_bytes += delta

    return _TaskCb


def submit(model_id: str, target_name: str | None = None) -> DownloadTask:
    """提交一个下载任务，立即返回 task 对象（state=queued）。"""
    if not model_id or "/" not in model_id:
        raise ValueError("model_id 必须形如 'org/name'")

    name = target_name or model_id.split("/")[-1]
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError(f"非法 target_name: {name!r}")

    target_dir = config.MODELS_DIR / name
    if target_dir.exists() and any(target_dir.iterdir()):
        # 已存在且非空：拒绝重新下载，避免覆盖
        raise FileExistsError(f"目录 {target_dir} 已存在且非空")

    task = DownloadTask(
        task_id=uuid.uuid4().hex,
        model_id=model_id,
        target_name=name,
    )
    with _tasks_lock:
        _tasks[task.task_id] = task

    threading.Thread(target=_run_task, args=(task,), name=f"dl-{task.task_id[:8]}", daemon=True).start()
    return task


def get(task_id: str) -> DownloadTask | None:
    with _tasks_lock:
        return _tasks.get(task_id)


def list_recent(limit: int = 20) -> list[DownloadTask]:
    """按 started_at 倒序，未开始的排在最后。"""
    with _tasks_lock:
        items = list(_tasks.values())
    items.sort(key=lambda t: (t.started_at or 0), reverse=True)
    return items[:limit]


def _run_task(task: DownloadTask) -> None:
    # 全局串行化：一次只跑一个下载
    with _run_lock:
        target_dir = config.MODELS_DIR / task.target_name
        target_dir.mkdir(parents=True, exist_ok=True)
        cb_cls = _make_callback_class(task)

        with task.lock:
            task.state = "running"
            task.started_at = time.time()

        logger.info("开始下载 %s → %s", task.model_id, target_dir)
        try:
            snapshot_download(
                model_id=task.model_id,
                local_dir=str(target_dir),
                progress_callbacks=[cb_cls],
            )
            with task.lock:
                task.state = "done"
                task.ended_at = time.time()
            logger.info("下载完成 %s（%.1fs，%d 文件）", task.model_id,
                        (task.ended_at - task.started_at), len(task.files))
        except Exception as exc:
            logger.exception("下载失败 %s", task.model_id)
            with task.lock:
                task.state = "error"
                task.error = str(exc)
                task.ended_at = time.time()
            # 失败时清理半下载的目录，避免下次 submit 撞 FileExistsError
            _cleanup_partial(target_dir)


def _cleanup_partial(path: Path) -> None:
    if not path.is_dir():
        return
    try:
        for child in path.iterdir():
            if child.is_file():
                child.unlink(missing_ok=True)
            elif child.is_dir():
                # 简单保守：不递归删，避免误删用户已存在内容
                pass
        if not any(path.iterdir()):
            path.rmdir()
    except OSError:
        logger.warning("清理半下载目录失败: %s", path)
