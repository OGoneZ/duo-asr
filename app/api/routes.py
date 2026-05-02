"""HTTP 路由：转写主接口 + 仪表盘统计 API。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import shutil
import time
import tomllib
import uuid

from fastapi import APIRouter, Body, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
import soundfile as sf

from app import config, db, downloader, model, models_registry, modelscope_search, recommended, stats
from app.logger import setup_logger

logger = setup_logger(__name__)

router = APIRouter()


def _archive_audio(audio_bytes: bytes, suffix: str = ".wav") -> tuple[Path, str]:
    """归档原始音频。返回 (绝对路径, 数据库存的相对路径)。"""
    today = datetime.now().strftime("%Y-%m-%d")
    day_dir = config.RECORDINGS_DIR / today
    day_dir.mkdir(parents=True, exist_ok=True)
    rec_id = uuid.uuid4().hex
    rel_path = f"{today}/{rec_id}{suffix}"
    abs_path = config.RECORDINGS_DIR / rel_path
    abs_path.write_bytes(audio_bytes)
    return abs_path, rel_path


def _audio_duration(path: Path) -> float | None:
    try:
        return float(sf.info(str(path)).duration)
    except Exception:
        logger.warning("无法读取音频时长: %s", path)
        return None


@router.post("/v1/audio/transcriptions")
async def transcribe(request: Request, file: UploadFile = File(...)):
    audio_bytes = await file.read()
    size = len(audio_bytes)
    size_str = f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.1f} KB"
    logger.info(f"收到文件: {file.filename}, 大小: {size_str}")

    suffix = Path(file.filename or "").suffix or ".wav"
    abs_path, rel_path = _archive_audio(audio_bytes, suffix=suffix)
    duration = _audio_duration(abs_path)

    record_base = {
        # 存 UTC ISO（带 Z），SQLite 用 datetime(..., 'localtime') 正确转本地时区
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio_filename": file.filename,
        "audio_path": rel_path,
        "audio_size": size,
        "audio_duration": duration,
        "client_ip": getattr(request.state, "client_ip", None),
        "client_host": getattr(request.state, "client_host", None),
        "model_name": config.MODEL_NAME,
    }

    start_time = time.time()
    try:
        result = model.transcribe(str(abs_path))
    except Exception as exc:
        elapsed = time.time() - start_time
        logger.exception("转写请求失败: filename=%s", file.filename)
        db.insert_transcription({
            **record_base,
            "inference_ms": int(elapsed * 1000),
            "text_raw": None,
            "text_final": None,
            "char_count": 0,
            "keystroke_count": 0,
            "error": str(exc),
        })
        raise

    elapsed = time.time() - start_time
    logger.info(f"转写完成, 耗时: {elapsed:.2f}秒")

    char_count = len(result.final) if result.final else 0
    keystroke_count = stats.estimate_keystrokes(result.final)
    post_processed = 1 if (result.raw and result.final and result.raw != result.final) else 0
    db.insert_transcription({
        **record_base,
        "inference_ms": result.inference_ms,
        "text_raw": result.raw,
        "text_final": result.final,
        "char_count": char_count,
        "keystroke_count": keystroke_count,
        "post_processed": post_processed,
        "error": None,
    })

    return JSONResponse({"text": result.final})


# ---------- Dashboard 与统计 API ----------

@router.get("/")
async def root_redirect():
    return RedirectResponse(url="/dashboard/")


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/api/stats/summary")
async def stats_summary(
    client: str | None = Query(None),
    days: int | None = Query(None, ge=1, le=3650),
):
    s = db.query_summary(client, days=days)
    duration = s.get("total_duration_sec") or 0
    chars = s.get("total_chars") or 0
    count = s.get("total_count") or 0
    s["chars_per_minute"] = round(chars * 60 / duration, 1) if duration > 0 else 0
    s["avg_duration_sec"] = round(duration / count, 1) if count > 0 else 0
    return s


@router.get("/api/stats/daily")
async def stats_daily(
    days: int = Query(30, ge=1, le=365),
    client: str | None = Query(None),
):
    return db.query_daily(days, client)


@router.get("/api/stats/clients")
async def stats_clients():
    return db.query_clients()


@router.get("/api/stats/by-client")
async def stats_by_client(days: int = Query(30, ge=1, le=365)):
    return db.query_by_client(days)


@router.get("/api/stats/recent")
async def stats_recent(
    n: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None),
    client: str | None = Query(None),
    since: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    until: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    post_processed: int | None = Query(None, ge=0, le=1),
):
    return db.query_recent(
        n, offset, q=q, client=client,
        since=since, until=until, post_processed=post_processed,
    )


@router.get("/api/recordings/{rec_id}")
async def recording_detail(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec:
        raise HTTPException(404, "not found")
    return rec


@router.get("/api/recordings/{rec_id}/audio")
async def recording_audio(rec_id: int):
    rec = db.get_by_id(rec_id)
    if not rec or not rec.get("audio_path"):
        raise HTTPException(404, "audio not found")
    abs_path = config.RECORDINGS_DIR / rec["audio_path"]
    if not abs_path.is_file():
        raise HTTPException(410, "audio file removed")
    return FileResponse(abs_path, media_type="audio/wav", filename=abs_path.name)


# ---------- 热词管理 ----------

@router.get("/api/hotwords")
async def get_hotwords():
    """返回 hotwords.toml 原文 + 解析后的结构化数据。"""
    path = config.HOTWORDS_FILE
    if not path.is_file():
        return {"text": "", "parsed": {}, "exists": False}
    text = path.read_text(encoding="utf-8")
    try:
        parsed = tomllib.loads(text).get("hotwords", {})
    except Exception as exc:
        return {"text": text, "parsed": None, "error": str(exc), "exists": True}
    return {"text": text, "parsed": parsed, "exists": True}


@router.put("/api/hotwords")
async def put_hotwords(payload: dict = Body(...)):
    """覆盖写入 hotwords.toml，校验通过后原子替换并自动备份上一版。

    payload: {"text": "<完整 toml 文本>"}
    """
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "缺少 text 字段")

    # 1) 语法校验 + schema 校验
    try:
        data = tomllib.loads(text)
    except Exception as exc:
        raise HTTPException(400, f"toml 解析失败: {exc}")
    hotwords = data.get("hotwords")
    if hotwords is None:
        raise HTTPException(400, "缺少 [hotwords] section")
    if not isinstance(hotwords, dict):
        raise HTTPException(400, "[hotwords] 必须是 table")
    for key, val in hotwords.items():
        if isinstance(val, list):
            if not all(isinstance(v, str) for v in val):
                raise HTTPException(400, f"hotword {key!r}: 列表元素必须全为字符串")
        elif isinstance(val, dict):
            variants = val.get("variants", [])
            if not isinstance(variants, list) or not all(isinstance(v, str) for v in variants):
                raise HTTPException(400, f"hotword {key!r}.variants 必须是字符串列表")
            if "pinyin" in val:
                if not isinstance(val["pinyin"], list) or not all(isinstance(v, str) for v in val["pinyin"]):
                    raise HTTPException(400, f"hotword {key!r}.pinyin 必须是字符串列表")
        else:
            raise HTTPException(400, f"hotword {key!r}: 必须是列表或 table")

    # 2) 备份上一版
    path = config.HOTWORDS_FILE
    if path.exists():
        bak = path.with_suffix(".toml.bak")
        bak.write_bytes(path.read_bytes())

    # 3) 原子写入：tmp + replace，避免半写入状态被热重载读到
    tmp = path.with_suffix(".toml.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)

    logger.info("hotwords.toml 已更新（%d 条规则）", len(hotwords))
    return {"ok": True, "count": len(hotwords)}


# ---------- 模型管理 ----------

@router.get("/api/models")
async def get_models():
    """列出 models/ 下已下载的模型 + 当前激活标记 + 推荐清单。

    推荐项里 ``downloaded`` 字段标记是否已落到本地（按 model_id 末段做匹配，
    与 downloader 的默认 target_name 一致）。
    """
    downloaded = [m.to_dict() for m in models_registry.list_models()]
    downloaded_names = {m["name"] for m in downloaded}

    families = []
    for fam in recommended.RECOMMENDED:
        fam_dict = fam.to_dict()
        any_downloaded = False
        any_current = False
        for v in fam_dict["variants"]:
            target_name = v["model_id"].split("/")[-1]
            v["target_name"] = target_name
            v["downloaded"] = target_name in downloaded_names
            v["is_current"] = (target_name == config.MODEL_NAME)
            if v["downloaded"]:
                any_downloaded = True
            if v["is_current"]:
                any_current = True
        fam_dict["any_downloaded"] = any_downloaded
        fam_dict["any_current"] = any_current
        fam_dict["variant_count"] = len(fam_dict["variants"])
        families.append(fam_dict)

    return {
        "active": config.MODEL_NAME,
        "models_dir": str(config.MODELS_DIR),
        "items": downloaded,
        "recommended": families,
    }


@router.post("/api/models/download")
async def post_model_download(payload: dict = Body(...)):
    """提交下载任务。立即返回 task_id；任务异步在后台运行。

    payload: {"model_id": "iic/SenseVoiceSmall", "target_name": "<可选>"}
    """
    model_id = (payload.get("model_id") or "").strip()
    target_name = payload.get("target_name")
    if not model_id:
        raise HTTPException(400, "缺少 model_id")
    try:
        task = downloader.submit(model_id, target_name)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except FileExistsError as exc:
        raise HTTPException(409, str(exc))
    return {"task_id": task.task_id}


@router.get("/api/models/download/{task_id}")
async def get_model_download(task_id: str):
    """查询下载任务状态。前端 polling 用。"""
    task = downloader.get(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task.to_dict()


@router.get("/api/models/downloads")
async def get_model_downloads():
    """最近的下载任务列表（含进行中和已完成）。"""
    return {"items": [t.to_dict() for t in downloader.list_recent()]}


@router.post("/api/models/download/{task_id}/cancel")
async def post_model_download_cancel(task_id: str):
    """暂停下载（保留 ._____temp/ 残留供续传）。
    下次 submit 同一 model_id 会从断点恢复。
    要彻底放弃任务并删除残留 → 调用 /abort。"""
    ok = downloader.cancel(task_id)
    if not ok:
        raise HTTPException(404, "任务不存在或已结束")
    return {"ok": True}


@router.post("/api/models/download/{task_id}/abort")
async def post_model_download_abort(task_id: str):
    """彻底放弃下载：set cancel_requested + 立刻 rmtree 目标目录 +
    后台兜底再 rmtree（modelscope worker 在下个 chunk 边界退出）。"""
    ok = downloader.abort(task_id)
    if not ok:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


@router.get("/api/models/search")
async def search_modelscope(
    q: str = Query("", description="模糊关键词，匹配模型名"),
    page: int = Query(1, ge=1, le=50),
    page_size: int = Query(20, ge=5, le=50),
):
    """关键词搜索 ModelScope 模型库（公网代理 + 本地缓存）。

    Tasks 过滤在公开 API 上无效，搜索结果会包含非 ASR 模型；前端按 ``is_asr``
    标记区分。每条结果带 ``downloaded`` 字段，标记本地是否已存在同名目录。
    """
    if not q.strip():
        return {"query": "", "page": page, "page_size": page_size, "total": 0, "items": []}
    try:
        result = await modelscope_search.search(q, page=page, page_size=page_size)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))

    # 联表已下载状态
    downloaded_names = {m.name for m in models_registry.list_models()}
    for item in result["items"]:
        item["downloaded"] = item["name"] in downloaded_names
        item["is_current"] = (item["name"] == config.MODEL_NAME)
    return result


@router.post("/api/models/active")
async def post_model_active(payload: dict = Body(...)):
    """切换激活模型。同步执行（包含释放旧模型 + 加载新模型）。

    payload: {"name": "<已下载模型名>"}
    """
    name = (payload.get("name") or "").strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(400, f"非法模型名: {name!r}")
    target = config.MODELS_DIR / name
    if not target.is_dir():
        raise HTTPException(404, f"模型不存在: {name}")
    if name == config.MODEL_NAME:
        return {"ok": True, "active": name, "unchanged": True}

    try:
        # 加载是 CPU/GPU 重活，丢到线程池避免阻塞 event loop
        import asyncio
        await asyncio.to_thread(model.switch_model, name)
    except Exception as exc:
        raise HTTPException(500, f"切换失败: {exc}")
    return {"ok": True, "active": config.MODEL_NAME}


@router.delete("/api/models/{name}")
async def delete_model(name: str):
    """删除一个已下载的模型目录。

    安全约束：
      - 名字不允许 path traversal 字符
      - 不允许删除当前激活模型
      - 目标必须确实位于 MODELS_DIR 下（resolve 后比较）
    """
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(400, f"非法模型名: {name!r}")
    if name == config.MODEL_NAME:
        raise HTTPException(409, "不能删除当前激活的模型，请先切换到其他模型")

    target = (config.MODELS_DIR / name).resolve()
    try:
        target.relative_to(config.MODELS_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "目标路径不在 models/ 目录下")
    if not target.is_dir():
        raise HTTPException(404, f"模型不存在: {name}")

    # 若目录是 symlink，rmtree 会拒；先单独 unlink
    if target.is_symlink():
        target.unlink()
    else:
        shutil.rmtree(target)
    logger.info("已删除模型目录: %s", target)
    return {"ok": True, "deleted": name}
