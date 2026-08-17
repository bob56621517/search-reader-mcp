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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **01-config**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"01-config 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/05-mcp-search-desc feat/v7-read-cache-mcp ./src-05-mcp-search-desc`
3. **实现**:按本 ticket 实现要点完成,单测通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/05-mcp-search-desc`);跨会话/中断时按需留交接文档。
