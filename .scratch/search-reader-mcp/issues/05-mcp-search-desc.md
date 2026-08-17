# 05 · MCP search 工具描述 env 化

Type: task
Status: ready-for-agent
Blocked by: 01

## 目标

`search` 工具及其参数描述改为经 `config.mcpDesc` 注入,env 可覆盖,缺省回退内建描述。search 工具逻辑/行为不变。

## 实现要点

- `search` 工具 `description` 与各参数 `describe()` 从 `config.mcpDesc.search` 读取。
- env 名:`MCP_SEARCH_DESC`(工具)、`MCP_SEARCH_TYPE`/`MCP_SEARCH_QUERY`/`MCP_SEARCH_COUNT`/`MCP_SEARCH_FRESHNESS`/`MCP_SEARCH_INCLUDE`(单数,与代码参数一致)/`MCP_SEARCH_EXCLUDE`(各参数)。
- 行为锚定不变:`type` 默认 `ai`、`count` 钳制 1..50、`freshness` 非法回退 `noLimit`、异常返回可读错误文本;search 不加 timeout 参数。

## 验收

- 单测:`mcpDesc` env 覆盖后工具/参数描述随之变化;env 缺省回退内建描述;行为不变。

## 依据

`.scratch/search-reader-mcp/spec.md`(描述 env 化 / search 工具)、`v7-read-cache-mcp.md`(五)。
