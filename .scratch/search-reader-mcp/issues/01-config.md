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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(本 ticket **无依赖**)。若有未完成依赖(其 `Status` 非 `resolved`),先提示用户"任务 XX 未完成(阻塞本任务),是否先执行 XX?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/01-config feat/v7-read-cache-mcp ./src-01-config`
   (worktree 目录放仓库内 `./src-*`,已由 `.gitignore` 忽略;Claude Code 同样支持仓库内 worktree)
3. **实现**:按本 ticket 实现要点完成,单测通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/01-config`);跨会话/中断时按需留交接文档。
