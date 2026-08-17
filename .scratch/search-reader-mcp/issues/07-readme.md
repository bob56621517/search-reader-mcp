# 07 · README 手册化

Type: task
Status: resolved
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

## Answer

`README.md` 手册化重组,结构 = 介绍 / 快速开始 / 配置(全部 env 表)/ API / 文件解析(上传)/ 缓存与超时 / 开发 / 参考:

- **API-read**:全量挂载路由表(`/read/**`、`/r` 完全同义、任意 method;`GET /read` 透传 jina 原生根、`POST /read` 上传解析不缓存、其余 method 透传不缓存);URL 编码 + query string 原样保留(修复丢 query bug 的文档化);`X-Engine`(browser/curl,缺省 auto,各 engine 独立缓存)与 `X-Read-Timeout`(缺省 `READ_TIMEOUT`,超时 504,缓存命中不占预算);非 http(s) 指路到文件解析章节。
- **文件解析(上传)章节 = 提示词模板权威依据**:curl 示例与逐项参数解释与 `src/mcp/read-tools.ts` 的 `UPLOAD_TEMPLATE` 逐字一致(`-X POST` / `{SERVER_URL}/read` / `-F 'file=@…'` 字段名固定 `file` / `x-engine: auto` / `x-retain-links: all` / `x-retain-images: all`);补 `page`(PDF 选页)、`url`(raw HTML base url)可选字段;注明上传解析不缓存。
- **配置表新增**:`READ_CACHE_TTL`、`READ_TIMEOUT`、`SERVER_URL`、全部 `MCP_*`(附 `MCP_<TOOL>_DESC`/`MCP_<TOOL>_<PARAM>` 模式与逐项清单)。
- **缓存与超时章节**:缓存键 = uri(含 query)+ engine 归一化三值、TTL 滑动续期、惰性删除 + 每小时兜底清理、in-flight 去重、只缓存成功响应、命中不占预算、落盘位置;超时三层表(jina `x-timeout` ≤180 透传软预算 / HTTP 层 `X-Read-Timeout`>env 硬 504 / MCP `timeout` ≤600 可读错误文本)+ clamp-180 透传映射。
- **MCP 章节**:read 工具新参数表(uri/skip/length/engine/timeout,含默认/校验/engine 映射/timeout 默认链/一次一个 uri/截断提示语义/非 http(s) 模板);search 工具行为表。
- 目录结构补 `src/mcp/read-tools.ts`、`src/cache/` 职责;参考章节补 roadmap、docs/agents。

`npm test` 全量通过(README 纯文档改动,不触碰代码);已 merge --no-ff 回基线 `feat/v7-read-cache-mcp`(无冲突)。
