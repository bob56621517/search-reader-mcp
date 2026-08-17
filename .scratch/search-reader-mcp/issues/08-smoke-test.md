# 08 · 容器冒烟测试扩展

Type: task
Status: ready-for-agent
Blocked by: 03, 04, 05

## 目标

扩展 `docs/smoke-test.md`,覆盖本期增强的容器内行为(依赖真实 jina/Chrome,不进常规单测)。

## 实现要点

- `GET /read/<url>`(路径即 url,含 query 保留断言)。
- `POST /read` 上传解析(PDF / HTML)。
- 缓存命中/滑动续期/失效重抓。
- MCP 工具调用:read(uri/skip/length/engine/timeout、截断提示、非 http(s) 模板)、search(行为锚定)。
- 上传解析对 header(`x-engine`/`x-retain-links`/`x-retain-images`)的实际支持确认。
- docker exec 列 jina koaApp 实际路由清单,确认 `/read/**` 全量覆盖。

## 验收

- 冒烟脚本按序跑通,各断言通过;发现的偏差回填到实现 ticket 或规格。

## 依据

`.scratch/search-reader-mcp/spec.md`(测试决策)、`v7-read-cache-mcp.md`(十一)。
