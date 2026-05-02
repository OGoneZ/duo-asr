"""FastAPI 应用装配：lifespan + 中间件 + 异常处理 + 路由 + 静态资源。"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import config, db, model
from app.api import exceptions, middleware
from app.api.routes import router
from app.logger import setup_logger

logger = setup_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 服务启动时初始化数据库 + 预加载模型，避免首条语音请求触发冷启动。
    logger.info("服务启动中，初始化数据库")
    db.init()
    config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    logger.info("预加载模型")
    try:
        model.load_model()
    except Exception:
        logger.exception("服务启动失败，模型预加载异常")
        raise
    logger.info("服务启动完成")
    try:
        yield
    finally:
        logger.info("服务正在关闭")


app = FastAPI(lifespan=lifespan)

exceptions.register(app)
app.middleware("http")(middleware.restrict_ip)

# 静态资源（dashboard）— 仅在目录存在时挂载，避免冷启动报错
if config.STATIC_DIR.exists():
    app.mount(
        "/dashboard",
        StaticFiles(directory=str(config.STATIC_DIR / "dashboard"), html=True),
        name="dashboard",
    )

app.include_router(router)
