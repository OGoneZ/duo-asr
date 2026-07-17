# ASR Server

基于 Qwen3-ASR-1.7B 的语音识别 HTTP 服务，兼容 OpenAI `/v1/audio/transcriptions` 接口格式，并内置中文数字后处理（将中文数字转换为阿拉伯数字）。TLS 由外部反向代理（如 Caddy）承担，本服务专注于应用逻辑。

## 功能特性

- **语音识别**：使用 Qwen3-ASR-1.7B 模型，支持中英文混合识别
- **中文数字后处理**：自动将识别结果中的中文数字转换为阿拉伯数字
- **热词修正**：支持精确匹配 + 拼音匹配两种模式，词典 `hotwords.toml` 支持热更新
- **使用面板**：内置 Dashboard（`/dashboard/`），统计字数 / 击键 / 时长，支持搜索与筛选
- **IP 白名单**：仅允许 `127.0.0.1`、`::1` 及 `10.0.0.0/24` 网段访问
- **日志归档**：按月分目录、按天分文件，路径格式为 `logs/YYYY-MM/YYYY-MM-DD.log`

## 中文数字后处理规则

| 场景 | 输入示例 | 输出示例 |
|------|----------|----------|
| 含单位字的整数 | 三百二十五元 | 325 元 |
| 亿/万级大数 | 一百二十三万四千五百六十七 | 1234567 |
| 纯小数 | 三点一四一五九 | 3.14159 |
| 含小数的数量 | 三十二点五度 | 32.5 度 |
| 时间表达 | 下午两点三十五分 | 下午 2 点 35 分 |
| 连续数字/年份 | 二零二五年 | 2025 年 |
| 幺字序列（电话/门牌）| 幺八幺三五七七 | 1813577 |
| IP 地址 | 幺九二点幺六八点一点一 | 192.168.1.1 |
| at 符号（艾特/AT）| root 艾特幺零点幺零点二零点三二 | root@10.10.20.32 |
| 域名/邮箱后缀 | example 点 com | example.com |

裸单位字（「百度」「万岁」「十分好」等）不会被误触发。

## 目录结构

```
asr-server/
├── main.py                  # 入口：启动 uvicorn
├── hotwords.toml            # 热词词典（运行时热更新）
├── pyproject.toml
├── app/                     # 业务包
│   ├── __init__.py          # 导出 FastAPI app
│   ├── config.py            # 全局常量
│   ├── logger.py            # 按日滚动日志
│   ├── errors.py            # 业务异常基类
│   ├── db.py                # SQLite 持久化
│   ├── stats.py             # 击键数估算
│   ├── model.py             # Qwen3-ASR 加载与推理
│   ├── api/                 # HTTP 边界
│   │   ├── __init__.py      # FastAPI 装配（lifespan + 中间件 + 路由）
│   │   ├── routes.py        # /v1/audio + /api/stats/* + /health
│   │   ├── middleware.py    # IP 白名单 + peer 解析
│   │   └── exceptions.py    # 4 类异常处理器
│   └── post_process/        # 后处理子系统（强耦合聚合）
│       ├── __init__.py      # 对外暴露 normalize_numbers
│       ├── core.py          # 数字 / 热词 / 字母序列规则
│       └── hot_reload.py    # 按 mtime 重载 core
├── static/dashboard/        # 前端资源
├── tests/                   # pytest
├── models/                  # 模型权重（gitignore）
├── data/                    # SQLite db（gitignore）
├── recordings/              # 转录原始音频（gitignore）
└── logs/                    # 运行日志（gitignore）
```

## 安装

需要 Python 3.12+，使用 [uv](https://github.com/astral-sh/uv) 管理依赖：

```bash
uv sync
```

## 启动服务

```bash
uv run main.py
```

服务默认监听 `0.0.0.0:9999`，纯 HTTP。前端面板访问 `http://localhost:9999/dashboard/`。

### MLX 量化模型

若使用 MLX 量化模型（如 Mano-ASR），需设置以下环境变量避免 CUDA cache 耗尽导致推理失败：

```bash
export MLX_CUDA_CONV_CACHE_SIZE=1024
export MLX_CUDA_GRAPH_CACHE_SIZE=1024
export MLX_CUDA_SDPA_CACHE_SIZE=1024
export MLX_CUDA_FFT_CACHE_SIZE=1024
```

原因：MLX 对卷积算法、CUDA Graph、attention 算子的缓存有上限（默认 128~400），大模型（≥1.7B）+ 8bit 量化的计算图复杂度会超出默认容量。MLX 的设计选择是抛 `RuntimeError: Cache thrashing` 而非静默驱逐旧条目，以确保用户感知到性能退化。

若使用标准 PyTorch 模型（`qwen-asr` 或 `funasr` backend）则无需关心以上变量。

## API

### POST /v1/audio/transcriptions

上传音频文件，返回转写文本。兼容 OpenAI Whisper API 格式。

```bash
curl -X POST http://localhost:9999/v1/audio/transcriptions \
  -F "file=@audio.wav"
```

```json
{ "text": "识别结果" }
```

### GET /health

健康检查。

```bash
curl http://localhost:9999/health
```

```json
{"status": "ok"}
```

### Dashboard 统计 API

| 路径 | 说明 |
|------|------|
| `GET /api/stats/summary` | 累计统计（支持 client / days 过滤） |
| `GET /api/stats/daily` | 每日聚合 |
| `GET /api/stats/clients` | 已知客户端列表 |
| `GET /api/stats/by-client` | 按客户端分桶 |
| `GET /api/stats/recent` | 最近转录（支持 q / since / until / post_processed） |
| `GET /api/recordings/{id}` | 单条详情 |
| `GET /api/recordings/{id}/audio` | 原始音频 |

## 运行测试

```bash
uv run pytest tests/
```

## 依赖

| 依赖 | 用途 |
|------|------|
| FastAPI | HTTP 框架 |
| uvicorn | ASGI 服务器 |
| PyTorch | 模型推理 |
| qwen-asr | Qwen3-ASR 模型封装 |
| librosa / soundfile | 音频读取 |
| pypinyin | 拼音匹配（热词 + 击键估算） |
