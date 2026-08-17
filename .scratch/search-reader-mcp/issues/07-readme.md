# 07 · README 手册化

Type: task
Status: ready-for-agent
Blocked by: 03, 04

## 目标

README 重组为使用手册:介绍 / 快速开始 / 配置 / API / 文件解析(上传)/ 缓存与超时 / 开发 / 参考。

## 实现要点

- API-read 部分:全量挂载路由表(`/read/**`、`/r` 同义、任意 method)、`POST /read` 上传、query 保留、engine/timeout 说明、非 http(s) 走文件解析章节。
- 文件解析(上传)章节:与提示词模板内容一致(curl 示例 + 参数解释、`SERVER_URL`、支持的格式),作为模板的权威依据。
- 配置表新增:`READ_CACHE_TTL`、`READ_TIMEOUT`、`SERVER_URL`、全部 `MCP_*`。
- 缓存与超时:说明缓存键(uri+engine)、TTL/清理、in-flight 去重、timeout 三层。
- MCP 部分:read 工具新参数表(uri/skip/length/engine/timeout)、search 工具行为。

## 验收

- 手册可直接指导新用户完成部署、调用 read/search/MCP、上传解析与排障。

## 依据

`.scratch/search-reader-mcp/spec.md`(README 手册化)、`v7-read-cache-mcp.md`(八、九)。
