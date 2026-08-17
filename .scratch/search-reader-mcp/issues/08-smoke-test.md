# 08 · 容器冒烟测试扩展

Type: task
Status: resolved
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

## Answer

容器冒烟已按 compose(默认 TTL=300、卷挂载 `~/.search_reader_mcp`)全流程实测,更新 `docs/smoke-test.md` 与 `scripts/mcp-smoke.mjs`,并**发现/修复一个产品缺陷**。

**实测结果(全过)**:
- `GET /read/<url>` 真实抓取 200,query 保留;**实测发现:jina 会清理 `utm_source` 等追踪参数**(URL Source 只显示非 utm query)→ 容器断言改用非 utm 参数,强断言留宿主单测。
- `POST /read` HTML 上传 → 链接/图片以 markdown 保留,证明 `x-retain-links`/`x-retain-images: all` 实际生效;上传不缓存。
- 缓存(compose TTL=300):命中瞬时(ms 级)、命中滑动续期(`expire_at` 刷新为 now+300)、query 作缓存键(`?x=1` 独立条目)、过期惰性删除重抓(宿主单测覆盖)。
- MCP 工具:官方 SDK 真实客户端**双会话全过**;`scripts/mcp-smoke.mjs` **12/12 全过**(无状态适配后)。
- docker exec 路由清单:jina **不用 koa-router**,路由为 `registerRoutes()` 挂的中间件链,`serviceReady()` 后 `koaApp.middleware` 共 7 个,核心是 shimController(把 path 当目标 URL)。

**产品缺陷(已修复)**:`src/server.ts` 原用**单个 `StreamableHTTPServerTransport`** 服务所有会话,SDK transport 单实例只支持一个会话 → 首个客户端 initialize 后,新客户端被 400 `Server already initialized` 拒(服务退化为单客户端)。已改为 `/mcp` **无状态模式**(`sessionIdGenerator: undefined`,每次请求独立 transport+server),天然多客户端;`/sse` 保持连接级会话。宿主单测 71/71 通过,容器 rebuild 后真实客户端验证通过。

**回填**:缓存写 `expire_at` 基准缺陷(putRead 用请求开始时刻的 now,loader 耗时 ≥ TTL 时写入即失效)→ 记入 `v7-read-cache-mcp.md`「三」与 `02-cache`(修复建议:传 `Date.now()`,同步调宿主单测;是否修待定);MCP transport 缺陷与 UTM 清理记入 `v7-read-cache-mcp.md`「十二」。

已 merge 回基线 `feat/v7-read-cache-mcp` 并 push。
