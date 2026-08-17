# 01 · 配置层新增字段与 mcpDesc 结构

Type: task
Status: ready-for-agent
Blocked by:

## 目标

扩展配置层,为全量挂载/缓存/超时/描述 env 化提供字段与类型安全的结构。**本 ticket 是一切并行任务的接口根,优先完成。**

## 实现要点

- `Config` 新增:
  - `serverUrl`:env `SERVER_URL`,默认 `http://localhost:18081`(提示词模板渲染端点地址)。
  - `readCacheTtl`:env `READ_CACHE_TTL`(秒),默认 300。
  - `readTimeout`:env `READ_TIMEOUT`(秒),默认 90(HTTP 层整体超时兜底)。
- 新建 `mcpDesc` 配置结构:显式枚举全部工具/参数描述(类型安全,不做动态循环),缺省 = 现内建描述,env 有值覆盖。清单:
  - search:`MCP_SEARCH_DESC`、`MCP_SEARCH_TYPE`、`MCP_SEARCH_QUERY`、`MCP_SEARCH_COUNT`、`MCP_SEARCH_FRESHNESS`、`MCP_SEARCH_INCLUDE`(单数)、`MCP_SEARCH_EXCLUDE`
  - read:`MCP_READ_DESC`、`MCP_READ_URI`、`MCP_READ_SKIP`、`MCP_READ_LENGTH`、`MCP_READ_ENGINE`、`MCP_READ_TIMEOUT`

## 验收

- 新增 env 均生效且默认值正确;`mcpDesc` 结构与工具/参数一一对应,env 缺省回退内建描述。

## 依据

`.scratch/search-reader-mcp/spec.md`(配置新增 / 描述 env 化)、`.scratch/search-reader-mcp/v7-read-cache-mcp.md`(九、完整 env 清单)。
