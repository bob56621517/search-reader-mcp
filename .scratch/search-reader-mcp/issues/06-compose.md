# 06 · docker-compose 补 env 注释

Type: task
Status: ready-for-agent
Blocked by:

## 目标

`docker-compose.yml` 补充本期新增 env 的注释与默认值,与 config 一致。

## 实现要点

- 在 `environment` 段补:`READ_CACHE_TTL`(300)、`READ_TIMEOUT`(90)、`SERVER_URL`(http://localhost:18081)。
- 补 `MCP_*` 描述 env 的注释(说明缺省 = 内建描述,可覆盖;不必逐一列出全部值)。
- 与 `src/config.ts` 默认值保持一致。

## 验收

- compose 启动后新增 env 生效;注释可读。

## 依据

`.scratch/search-reader-mcp/spec.md`(配置新增)、`v7-read-cache-mcp.md`(九)。
