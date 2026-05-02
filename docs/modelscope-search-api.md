# ModelScope 搜索 API 调研（2026-05）

下一阶段做"模型搜索 / 浏览"功能时复用本备忘。

## 可用 endpoint

`PUT https://modelscope.cn/api/v1/models/`（注意尾斜杠，否则 307 重定向）

请求体（JSON）：

```json
{
  "Path": "iic",                     // 可选：限定 owner
  "Name": "paraformer",              // 可选：模型名关键词模糊匹配
  "PageNumber": 1,
  "PageSize": 10
}
```

响应：`{ "Code": 200, "Data": { "TotalCount": N, "Models": [...] } }`

每条 model 字段（实际样例）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `Path` | str | owner（如 `iic`、`Qwen`） |
| `Name` | str | 模型名 |
| `ChineseName` | str | 中文名 |
| `Downloads` | int | 下载量 |
| `Stars` | int | 收藏数 |
| `Tasks` | list[dict] | 含 `Name` (`auto-speech-recognition`) / `DomainName` (`audio`) 等 |

## 走过的坑

- **`Tasks` 字段当过滤器无效**。我尝试 `{"Tasks":["auto-speech-recognition"]}` 仍然返回全部模型。`SortBy` 参数也没生效（返回 `TotalCount: None`）。
- **HTTP 方法是 PUT 而不是 GET**。GET 同 endpoint 返回 404。
- **关键词搜索可用**：`Name=asr` 能筛出 867 个、`Name=paraformer` 筛出 97 个，结果质量高。

## 推荐用法（3i 阶段实施时）

后端加 `GET /api/models/search?q=<keyword>&page=<n>` 路由：

```python
import httpx
async def search_modelscope(query: str, page: int = 1, page_size: int = 20):
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.put(
            "https://modelscope.cn/api/v1/models/",
            json={"Name": query, "PageNumber": page, "PageSize": page_size},
        )
    r.raise_for_status()
    body = r.json()
    return body.get("Data", {})
```

前端再做"自定义 → 搜索框"，列出结果，每条带「下载」按钮直接复用现有
`POST /api/models/download {model_id}` 流程。注意：

- 搜索结果包含 ASR 之外的模型（即使关键词命中），需要客户端层面做兼容性提示
- 下载前提示用户"非 Qwen3-ASR / FunASR 系列模型可能无法加载"
- 缓存搜索结果（避免每次切换页都重新打 ModelScope）
