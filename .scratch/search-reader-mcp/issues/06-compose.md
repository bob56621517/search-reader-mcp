# 06 · docker-compose 补 env 注释

Type: task
Status: resolved
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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(本 ticket **无依赖**)。若有未完成依赖,先提示用户后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/06-compose feat/v7-read-cache-mcp ./src-06-compose`
3. **实现**:按本 ticket 实现要点完成。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/06-compose`);跨会话/中断时按需留交接文档。

## Answer

在 `docker-compose.yml` 主服务 `environment` 段补入 v7 新增 env 及其注释,与 `v7-read-cache-mcp.md`(九)默认值一致:
- `READ_CACHE_TTL: "300"`(缓存 TTL 秒)、`READ_TIMEOUT: "90"`(HTTP 层整体超时兜底秒)、`SERVER_URL: "http://localhost:18081"`(模板渲染端点地址)。
- 追加 `MCP_*` 描述 env 注释块:说明缺省 = 内建描述、有值即覆盖,模式 `MCP_<TOOL>_DESC` / `MCP_<TOOL>_<PARAM>`,并给示例;不逐一列举全部变量。

`docker compose config -q` 校验通过;已 merge --no-ff 回基线 `feat/v7-read-cache-mcp`(合并提交无冲突)。
