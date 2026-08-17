# 03 · Jina 全量路由挂载 + query 保留 + bodyParser 分流 + 缓存接入 + timeout header

Type: task
Status: ready-for-agent
Blocked by: 02

## 目标

`/read/**` 全量透传 jina 原生路由,补齐 query string 保留,bodyParser 按 Content-Type 分流不吞 multipart,HTTP read 层接入缓存与超时。

## 实现要点

- 全量挂载:`/read` → jina `/`、`/read/<rest>` → `/<rest>`;`/r` 完全同义;任意 method。`POST /read`(无尾路径)→ jina `POST /` = 上传解析。
- **query 保留**:改写 `req.url` 时必须保留原始 query string(现实现丢 query,需补);缓存键目标 uri = 含 query 的完整 URL。
- **bodyParser 分流**:全局 bodyParser 不得吞 `/read/**` 的 multipart body;按 Content-Type 分流(JSON 留给 search,multipart 放行给 read 上传)。
- **缓存接入**:`handleRead` 命中 `read_cache`(键 = uri+engine,engine 取 `X-Engine` header 归一化)直接返回全文;miss 走 jina 抓取,成功写缓存;并发 in-flight 去重;`POST /read` 上传不缓存。
- **timeout header**:读 `X-Read-Timeout`(秒)作为本次请求整体硬超时,缺省走 `config.readTimeout`;超时 504;整体预算 clamp-180 透传为 jina `x-timeout`;超时不写缓存。
- 路由边界:我们 `/`、`/health` 为本服务 health;`/read/**` 专属 jina。
- 不引入 koa-mount,沿用 `handleRead` 手动改写模式。

## 验收

- 单测(supertest,mock jina 桥接):query 保留、`POST` 上传分流、缓存命中/失效、`X-Read-Timeout` 超时 504、health。
- 容器冒烟:`GET /read/<url>`、`POST /read` 上传、docker exec 列 jina koaApp 实际路由清单确认全量覆盖。

## 依据

`.scratch/search-reader-mcp/spec.md`(全量路由挂载 / 缓存 / timeout 体系)、`v7-read-cache-mcp.md`(二、三、七)。

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **02-cache**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"02-cache 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/03-route-mount feat/v7-read-cache-mcp ./src-03-route-mount`
3. **实现**:按本 ticket 实现要点完成,单测通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/03-route-mount`);跨会话/中断时按需留交接文档。
