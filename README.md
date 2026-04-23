# ASR Server

基于 Qwen3-ASR-1.7B 的语音识别 HTTP 服务，兼容 OpenAI `/v1/audio/transcriptions` 接口格式，并内置中文数字后处理（将中文数字转换为阿拉伯数字）。TLS 由外部反向代理（如 Caddy）承担，本服务专注于应用逻辑。

## 功能特性

- **语音识别**：使用 Qwen3-ASR-1.7B 模型，支持中英文混合识别
- **中文数字后处理**：自动将识别结果中的中文数字转换为阿拉伯数字
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
├── api.py              # FastAPI 路由与中间件
├── service.py          # 模型加载、转写与后处理逻辑
├── logger.py           # 按日滚动日志
├── qwen_asr_api.py     # 入口：启动 uvicorn
├── models/
│   └── Qwen3-ASR-1.7B/ # 模型权重（需手动下载）
├── logs/               # 运行日志（自动创建）
├── tests/
│   └── test_normalize.py
└── pyproject.toml
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

服务默认监听 `0.0.0.0:9999`，纯 HTTP。

可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ASR_HOST` | `0.0.0.0` | 监听地址 |
| `ASR_PORT` | `9999` | 监听端口 |

## API

### POST /v1/audio/transcriptions

上传音频文件，返回转写文本。兼容 OpenAI Whisper API 格式。

**请求**

```
Content-Type: multipart/form-data
```

| 字段 | 类型 | 说明 |
|------|------|------|
| file | file | 音频文件（推荐 WAV 格式）|

**响应**

```json
{ "text": "识别结果" }
```

**示例**

```bash
curl -X POST http://localhost:9999/v1/audio/transcriptions \
  -F "file=@audio.wav"
```

### GET /health

健康检查。

```bash
curl http://localhost:9999/health
```

```json
{"status": "ok"}
```

## 运行测试

```bash
uv run pytest tests/
```

共 45 个参数化测试用例，覆盖整数、小数、时间、年份、IP、at 符号、域名后缀及裸单位字防误触发等场景。

## 依赖

| 依赖 | 用途 |
|------|------|
| FastAPI | HTTP 框架 |
| uvicorn | ASGI 服务器 |
| PyTorch | 模型推理 |
| qwen-asr | Qwen3-ASR 模型封装 |
| librosa / soundfile | 音频读取 |
