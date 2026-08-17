# 04 · MCP read 工具增强:uri/skip/length/engine/timeout + 切片 + 截断 + 模板 + 描述注入

Type: task
Status: ready-for-agent
Blocked by: 01

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
