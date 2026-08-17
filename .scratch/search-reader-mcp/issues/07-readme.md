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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **03-route-mount、04-mcp-read**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"03/04 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/07-readme feat/v7-read-cache-mcp ./src-07-readme`
3. **实现**:按本 ticket 实现要点完成。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/07-readme`);跨会话/中断时按需留交接文档。
