# 04 · MCP read 工具增强:uri/skip/length/engine/timeout + 切片 + 截断 + 模板 + 描述注入

Type: task
Status: resolved
Blocked by: 01
<!-- 实现备注(2026-08-17):commit 3becb05 已实现,merge 8245bbf 解决与 05(searchDesc→config 收敛)的冲突。纯逻辑单测 test/mcp-read.test.js 覆盖切片/截断/模板渲染/schema 越界;容器冒烟(各参数/模板/截断)转 08-smoke-test 执行。 -->

## 目标

重构 MCP `read` 工具:支持分片续读、引擎、超时;非 http(s) 返回自包含提示词模板;描述经 `config.mcpDesc` 注入。本 ticket 与 03 可并行(接口 `readUrl` 已存在)。

## 实现要点

- 参数:`uri`(必填)、`skip`(默认 0,非负)、`length`(默认 5000,1..50000)、`engine`(`auto`/`direct`/`browser`)、`timeout`(正整数 ≤600);越界由 schema 拒绝。
- scheme 分流:http(s) → 正常抓取;其他(file/ftp/data…)→ 返回提示词模板。
- 切片:返回 `[skip, skip+length)` 纯文本切片;截断时(精确判断 `skip+length < 全文长度`)尾部追加提示(含全文长度与当前位置);完整返回不加提示。
- engine 映射:`direct` → `X-Engine: curl`、`browser` → `X-Engine: browser`、`auto` → 不传。
- timeout:默认链 per-call `timeout` > `config.readTimeout` > 90;self-call fetch 带 `X-Read-Timeout`;超时/504 转可读错误文本,不抛错。
- 模板:非 http(s) 返回自包含模板(curl 示例 + 逐项参数解释:`-X POST`、`{SERVER_URL}/read`、`-F file=@`、`x-engine`、`x-retain-links: all`、`x-retain-images: all`、响应说明);地址经 `config.serverUrl` 渲染;行为锚定:保留全部链接/图片 URL、不递归嵌套解析。
- 描述注入:工具/参数 `description` 来自 `config.mcpDesc`(env 覆盖)。

## 验收

- 纯逻辑单测:切片、截断提示、模板渲染(`SERVER_URL` 注入)、参数 schema 越界拒绝。
- 容器冒烟:经真实 MCP 调用 read(各参数、模板、截断)。

## 依据

`.scratch/search-reader-mcp/spec.md`(MCP read 工具 / 提示词模板)、`v7-read-cache-mcp.md`(四、六)。

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **01-config**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"01-config 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/04-mcp-read feat/v7-read-cache-mcp ./src-04-mcp-read`
3. **实现**:按本 ticket 实现要点完成,单测通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/04-mcp-read`);跨会话/中断时按需留交接文档。
