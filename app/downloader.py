"""Modelscope 异步下载任务管理。

设计要点：
- 进程内字典管理 task_id → DownloadTask 状态
- 单线程串行下载（同一时刻最多 1 个任务在跑），避免磁盘/带宽抢占
- 进度通过 ProgressCallback 子类回写 task，前端 polling 取
- 用户可以注册新任务、查询任意任务状态；不实现"取消"（modelscope 不暴露中断）
"""
from __future__ import annotations

import shutil
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


class _DownloadCancelled(Exception):
    """ProgressCallback 检测到 task.cancel_requested 时抛出，
    打断 modelscope snapshot_download 的同步阻塞。"""


@dataclass
class DownloadTask:
    task_id: str
    model_id: str            # modelscope 上的完整 id，如 "iic/SenseVoiceSmall"
    target_name: str         # 本地落点 models/<target_name>/
    state: str = "queued"    # queued / running / done / error / cancelled
    error: str | None = None
    cancel_requested: bool = False    # 用户点了取消/暂停 → callback 检测后 raise
    started_at: float | None = None
    ended_at: float | None = None
    files: dict[str, dict] = field(default_factory=dict)
    overall_bytes: int = 0
    overall_total: int = 0
    # 速度采样：每 0.5s+ 用瞬时差分 + EMA 平滑
    speed_bps: float = 0.0           # 平滑后的字节/秒
    _sample_time: float = 0.0        # 上次采样时间
    _sample_bytes: int = 0           # 上次采样的 overall_bytes
    lock: threading.Lock = field(default_factory=threading.Lock)

    def _maybe_sample_speed(self) -> None:
        """ProgressCallback.update 调用后立即调用，更新瞬时速度（持有 lock）。"""
        now = time.time()
        if self._sample_time == 0.0:
            self._sample_time = self.started_at or now
            self._sample_bytes = self.overall_bytes
            return
        elapsed = now - self._sample_time
        if elapsed < 0.5:
            return
        delta = self.overall_bytes - self._sample_bytes
        instant = max(0.0, delta / elapsed)
        # EMA：α=0.3 平滑瞬时跳变，新样本占 30%
        self.speed_bps = instant if self.speed_bps == 0 else 0.3 * instant + 0.7 * self.speed_bps
        self._sample_time = now
        self._sample_bytes = self.overall_bytes

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
            remaining = self.overall_total - self.overall_bytes
            eta = (
                int(remaining / self.speed_bps)
                if self.speed_bps > 0 and remaining > 0 else None
            )
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
                "speed_bps": int(self.speed_bps),
                "eta_seconds": eta,
                "cancel_requested": self.cancel_requested,
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
            # 在写入前检查取消标记：以 chunk 为粒度打断下载
            if task.cancel_requested:
                raise _DownloadCancelled()
            with task.lock:
                meta = task.files.get(self._filename)
                if meta is not None:
                    meta["downloaded"] += size
                    task.overall_bytes += size
                    task._maybe_sample_speed()

        def end(self):
            with task.lock:
                meta = task.files.get(self._filename)
                if meta is not None and meta["downloaded"] < meta["size"]:
                    delta = meta["size"] - meta["downloaded"]
                    meta["downloaded"] = meta["size"]
                    task.overall_bytes += delta
                    task._maybe_sample_speed()

    return _TaskCb


def submit(model_id: str, target_name: str | None = None) -> DownloadTask:
    """提交一个下载任务，立即返回 task 对象。

    几个边界处理：
    - 同名任务（target_name 相同）正在 queued/running → 直接复用该任务，
      不再新建。这能避免用户在前端刷新或重复点击「下载」时累积重复任务。
    - 目录已存在且非空但没有活跃任务 → 仍允许 submit，让 modelscope
      snapshot_download 自己处理（它对已下载文件按 hash 校验做断点续传）。
    """
    if not model_id or "/" not in model_id:
        raise ValueError("model_id 必须形如 'org/name'")

    name = target_name or model_id.split("/")[-1]
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError(f"非法 target_name: {name!r}")

    # 复用活跃任务（同 target_name）
    with _tasks_lock:
        for existing in _tasks.values():
            if existing.target_name == name and existing.state in ("queued", "running"):
                logger.info("复用已在进行的下载任务: %s (state=%s)",
                            existing.task_id, existing.state)
                return existing

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


def cancel(task_id: str) -> bool:
    """请求取消任务（暂停语义）：保留 ._____temp/ 残留以便续传。
    下次 ProgressCallback.update 调用时打断。
    返回 True 表示任务存在且尚未结束。"""
    with _tasks_lock:
        task = _tasks.get(task_id)
    if task is None:
        return False
    if task.state in ("done", "error", "cancelled"):
        return False
    task.cancel_requested = True
    return True


def abort(task_id: str) -> bool:
    """彻底放弃任务（取消语义）：set cancel + 立刻清空目标目录 + 后台兜底再清一次。

    与 cancel() 的区别：cancel 只是暂停（保留临时文件用于续传），
    abort 是放弃（删除整个目标目录）。
    返回 True 表示任务存在。
    """
    with _tasks_lock:
        task = _tasks.get(task_id)
    if task is None:
        return False

    target_dir = config.MODELS_DIR / task.target_name

    # 1. 触发取消标记 + 立刻把 state 置为 cancelled
    #    （否则 /api/models/downloads 的 active 过滤会继续看到这个任务还在跑，
    #     前端 loadModels 把进度卡又显示出来）
    #    modelscope worker 仍在 _run_lock 里跑，下个 chunk 边界后退出，
    #    _run_task 的异常处理路径会再次 set state=cancelled（幂等）。
    with task.lock:
        if task.state in ("queued", "running"):
            task.cancel_requested = True
            task.state = "cancelled"
            task.ended_at = time.time()

    # 2. 立刻 rmtree 一次（modelscope worker 可能仍在写，靠 ignore_errors 容错）
    if target_dir.is_dir():
        shutil.rmtree(target_dir, ignore_errors=True)

    # 3. 后台兜底：modelscope worker 退出后再 rmtree 一次（防止它在第 2 步后又写回）
    def _final_cleanup() -> None:
        # 等 worker 真退出：靠 _run_lock 串行 → 再次拿到 lock 就说明 worker 走了
        with _run_lock:
            pass
        if target_dir.is_dir():
            shutil.rmtree(target_dir, ignore_errors=True)
        with _tasks_lock:
            _tasks.pop(task.task_id, None)
        logger.info("abort 清理完成: %s", task.target_name)

    threading.Thread(
        target=_final_cleanup,
        name=f"abort-{task.task_id[:8]}",
        daemon=True,
    ).start()
    return True


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
                max_workers=8,
            )
            with task.lock:
                task.state = "done"
                task.ended_at = time.time()
            logger.info("下载完成 %s（%.1fs，%d 文件）", task.model_id,
                        (task.ended_at - task.started_at), len(task.files))
        except _DownloadCancelled:
            logger.info("下载已取消 %s（保留临时文件用于续传）", task.model_id)
            with task.lock:
                task.state = "cancelled"
                task.ended_at = time.time()
        except Exception as exc:
            # modelscope 用线程池下载时会把 callback raise 的异常 wrap 成
            # 别的类型，丢失 _DownloadCancelled 标识。靠 cancel_requested
            # 标记区分：是不是用户取消引起的。
            if task.cancel_requested:
                logger.info("下载已取消 %s（异常路径，cancel_requested=True）", task.model_id)
                with task.lock:
                    task.state = "cancelled"
                    task.ended_at = time.time()
            else:
                logger.exception("下载失败 %s", task.model_id)
                with task.lock:
                    task.state = "error"
                    task.error = str(exc)
                    task.ended_at = time.time()


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
