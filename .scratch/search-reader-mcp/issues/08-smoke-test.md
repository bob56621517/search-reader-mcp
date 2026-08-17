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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **03-route-mount、04-mcp-read、05-mcp-search-desc**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"03/04/05 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/08-smoke-test feat/v7-read-cache-mcp ./src-08-smoke-test`
3. **实现**:按本 ticket 实现要点完成,容器冒烟通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/08-smoke-test`);跨会话/中断时按需留交接文档。
