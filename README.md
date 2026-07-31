# ASR Server

基于 Qwen3-ASR-1.7B / Mano-ASR 的语音识别 HTTP 服务，兼容 OpenAI `/v1/audio/transcriptions` 接口格式，内置中文数字后处理、LLM 文本清理、模型管理面板。TLS 由外部反向代理（如 Caddy）承担，本服务专注于应用逻辑。

## 功能特性

- **语音识别**：支持 Qwen3-ASR、SenseVoice、Whisper 等多款 ASR 模型，热切换无需重启
- **LLM 后处理**：可选本地 GPU 推理（llama-cpp-python + Qwen3.5 4B Q4_K_M）或云端 Endpoint 对转写结果进行二次清理
- **中文数字后处理**：自动将识别结果中的中文数字转换为阿拉伯数字
- **热词修正**：支持精确匹配 + 拼音匹配两种模式，词典 `hotwords.toml` 支持热更新
- **使用面板**：内置 Dashboard（`/dashboard/`），统计字数 / 击键 / 时长 / 推理耗时，支持搜索与筛选
- **模型管理**：Web 页面管理 ASR 模型和后处理模型，支持 ModelScope 搜索、下载、切换
- **IP 白名单**：仅允许 `127.0.0.1`、`::1` 及 `10.0.0.0/24` 网段访问
- **日志归档**：按月分目录、按天分文件，路径格式为 `logs/YYYY-MM/YYYY-MM-DD.log`

## 性能

| 阶段 | 耗时 |
|------|------|
| ASR 推理 (Mano-ASR MLX 8-bit) | ~0.2s |
| LLM 后处理 (Qwen3.5 4B CUDA) | ~0.3s |
| 总计 | ~0.5s |

GPU 显存占用：ASR ~2.5 GB + LLM ~3.2 GB ≈ 5.7 GB。

## 目录结构

```
asr-server/
├── main.py                       # 入口
├── hotwords.toml                 # 热词词典
├── default_prompt.txt            # LLM 清理 Prompt（可热编辑）
├── pyproject.toml
├── app/
│   ├── api/
│   │   ├── __init__.py           # FastAPI 装配
│   │   ├── routes.py             # 转写 + 统计 + 模型管理 + 后处理 API
│   │   ├── middleware.py          # IP 白名单
│   │   └── exceptions.py         # 异常处理
│   ├── backends/                 # ASR 后端（可插拔）
│   │   ├── base.py               # Backend 协议
│   │   ├── qwen.py               # Qwen3-ASR (PyTorch)
│   │   ├── funasr.py             # FunASR (SenseVoice/Paraformer/Whisper)
│   │   └── mlx_qwen.py           # MLX 量化 Qwen3-ASR
│   ├── post_process/             # 中文数字后处理
│   │   ├── core.py               # 数字/热词/字母序列规则
│   │   └── hot_reload.py         # 按 mtime 热重载
│   ├── post_process_model.py     # LLM 后处理：配置 + 推理
│   ├── model.py                  # 模型生命周期管理
│   ├── models_registry.py        # 模型目录扫描
│   ├── config.py                 # 全局配置
│   ├── db.py                     # SQLite 持久化
│   ├── stats.py                  # 击键数估算
│   ├── downloader.py             # ModelScope 异步下载
│   ├── recommended.py            # 推荐 ASR 模型清单
│   └── modelscope_search.py      # ModelScope 搜索代理
├── models/                       # 模型权重
│   ├── asr/                      # ASR 模型（HuggingFace 目录格式）
│   └── llm/                      # LLM 模型（GGUF 文件）
├── static/dashboard/             # 前端面板
├── docs/                         # 文档
│   └── cuda-acceleration.md      # CUDA 编译指南
├── tests/                        # pytest
├── data/                         # SQLite + 配置持久化
├── recordings/                   # 转录原始音频
└── logs/                         # 运行日志
```

## 安装

需要 Python 3.12+，使用 [uv](https://github.com/astral-sh/uv) 管理依赖：

```bash
uv sync
```

### CUDA 加速（LLM 后处理）

PyPI 的 `llama-cpp-python` wheel 是 CPU-only。GPU 推理需要从源码编译，详见 `docs/cuda-acceleration.md`。

### LLM 模型下载

```bash
# 从 HuggingFace 下载 unsloth 4-bit 量化 GGUF
ALL_PROXY=http://127.0.0.1:7897 hf download unsloth/Qwen3.5-4B-GGUF \
  Qwen3.5-4B-Q4_K_M.gguf --local-dir models/llm/
```

## 启动服务

```bash
uv run main.py
```

服务默认监听 `0.0.0.0:9999`，纯 HTTP。前端面板访问 `http://localhost:9999/dashboard/`。

### MLX 量化模型环境变量

若使用 MLX 量化模型（如 Mano-ASR），需设置：

```bash
export MLX_CUDA_CONV_CACHE_SIZE=1024
export MLX_CUDA_GRAPH_CACHE_SIZE=1024
export MLX_CUDA_SDPA_CACHE_SIZE=1024
export MLX_CUDA_FFT_CACHE_SIZE=1024
```

## API

### POST /v1/audio/transcriptions

```bash
curl -X POST http://localhost:9999/v1/audio/transcriptions -F "file=@audio.wav"
# {"text": "识别结果"}
```

### GET /health

```bash
curl http://localhost:9999/health
# {"status": "ok"}
```

### Dashboard 统计 API

| 路径 | 说明 |
|------|------|
| `GET /api/stats/summary` | 累计统计（含 avg_postprocess_ms） |
| `GET /api/stats/daily` | 每日聚合 |
| `GET /api/stats/recent` | 最近转录（含 postprocess_ms / post_model_name） |
| `GET /api/recordings/{id}` | 单条详情 |
| `GET /api/recordings/{id}/audio` | 原始音频 |

### 后处理模型 API

| 路径 | 说明 |
|------|------|
| `GET /api/post-process/config` | 获取配置 + 本地模型列表 |
| `PUT /api/post-process/config` | 更新配置 |
| `POST /api/post-process/test` | 测试文本清理 |
| `POST /api/post-process/active` | 切换激活模型 |
| `GET /api/post-process/search` | 搜索 ModelScope LLM |
| `POST /api/post-process/download` | 下载模型 |

### 模型管理 API

| 路径 | 说明 |
|------|------|
| `GET /api/models` | 已安装模型 + 推荐列表 |
| `POST /api/models/active` | 切换 ASR 模型 |
| `POST /api/models/download` | 下载模型 |
| `DELETE /api/models/{name}` | 删除模型 |

## 运行测试

```bash
uv run pytest tests/
```

## 依赖

| 依赖 | 用途 |
|------|------|
| FastAPI / uvicorn | HTTP 框架 |
| PyTorch | ASR 模型推理 |
| qwen-asr | Qwen3-ASR 封装 |
| funasr | SenseVoice/Paraformer/Whisper 后端 |
| mlx / mlx-qwen3-asr | MLX 量化推理 |
| llama-cpp-python | LLM GGUF 推理 |
| librosa / soundfile | 音频读取 |
| pypinyin | 拼音匹配 + 击键估算 |
| httpx | HTTP 客户端（endpoint 模式） |
