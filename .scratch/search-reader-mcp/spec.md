# search-reader-mcp 一期增强 spec

Status: ready-for-agent

## Problem Statement

整合服务器(ADR-0001)已提供基础 read/search/mcp/sse。当前 read 能力受三处限制:① 路由只支持 `GET /read/<url>` 且**改写 `req.url` 时丢失 query string**;② 无缓存,同一 URL 每次都走 Chrome 全量渲染(最贵);③ MCP `read` 工具只有 `url` 一个参数,无分页/引擎/超时控制,非 http(s) 资源(本地文件等)只能生硬报错。此外 MCP 工具描述硬编码在代码里,部署者无法按场景定制。README 偏简略,不足以充当使用手册。

用户需要:jina 的 read 能力以**全量路由**形态透传(含 `POST` 文件上传解析),抓取结果**缓存**复用,`read` MCP 工具支持**分片续读/引擎/超时**,非 http(s) 资源给出**可执行的引导**而非报错,工具描述**可 env 覆盖**,README 升级为**手册**。

## Solution

在整合服务器上做一期增强,交付形态不变(单服务、单端口):

- **Jina 全量路由挂载**:`/read/**` 全量透传 jina 原生路由(`/r` 同义、任意 method),保留 query string;`POST /read` 即原生文件上传解析(multipart `file` → Markdown);bodyParser 按 Content-Type 分流不吞 multipart。
- **read 缓存**:一级缓存仅缓存解析后的 Markdown,键 = `uri(含 query)+ engine`,TTL 默认 300s 滑动续期,惰性删除叠加每小时兜底清理,同键 in-flight 去重;HTTP 层与 MCP self-call 共用。
- **MCP `read` 工具增强**:参数 `uri`/`skip`/`length`/`engine`/`timeout`;返回 `[skip, skip+length)` 纯文本切片(默认 5000 字符,上限 50000),截断时尾部提示可续读;`engine` 三枚举 `auto`/`direct`/`browser`;`timeout` 整体预算(默认链 `timeout` > env `READ_TIMEOUT` > 90s,上限 600);一次一个 uri 不支持并行。
- **非 http(s) 处理**:不实现任何下载协议;返回**自包含提示词模板**,引导 agent 自行下载后经 `POST /read` 上传解析(端点地址由 `SERVER_URL` env 渲染,参数对齐 MCP 功能)。
- **描述 env 化**:工具与参数描述经 `MCP_<TOOL>[_<PARAM>]_DESC` 形式 env 覆盖,缺省为内建描述。
- **timeout 体系**:三层(MCP 参数 → HTTP `X-Read-Timeout` 硬超时 → clamp-180 的 jina `x-timeout` 透传)。
- **README 手册化** + 文档(ADR/roadmap/CONTEXT)同步。

## User Stories

1. 作为使用者,我想 `GET /read/<url>`(URL 含 query string)把网页转成 Markdown,且 URL 的 query 不丢失,以便读取带参数的动态页面。
2. 作为使用者,我想 `POST /read` 上传本地文件(PDF/Word/Excel/PPT/HTML/纯文本)解析为 Markdown,以便不托管文件即可读取其内容。
3. 作为使用者,我想对同一 URL 的重复读取命中缓存、快速返回,以便减少重复抓取等待。
4. 作为使用者,我想缓存命中时不被算进超时预算,以便大文件分片续读时每次续读都快。
5. 作为 MCP 客户端,我想 `read` 工具用 `uri` 传地址,以便读取网页/PDF 内容。
6. 作为 MCP 客户端,我想 `read` 工具用 `skip`/`length` 分片读取长文,以便在上下文窗口内按需取段。
7. 作为 MCP 客户端,我想切片恰好到文末时不加多余提示、被截断时尾部提示全文长度与剩余位置,以便知道是否还有内容可续读。
8. 作为 MCP 客户端,我想 `read` 工具用 `engine` 控制抓取方式(`auto`/`direct`/`browser`),以便动态页面用浏览器渲染、静态内容走轻量抓取。
9. 作为 MCP 客户端,我想 `read` 工具用 `timeout` 控制单次读取的整体预算,以便读取 20MB 级大文件时不被默认超时掐断。
10. 作为 MCP 客户端,我想 `read` 传入非 http(s) 的 uri 时收到自包含的引导(自行下载 → `POST /read` 上传),而不是生硬报错,以便能自主完成对本地/私有文件的读取。
11. 作为 MCP 客户端,我希望引导模板里给出可执行的 `curl` 示例与逐项参数解释,以便不用再去查文档就能执行。
12. 作为 MCP 客户端,我希望 `read` 一次只读一个 uri,以便行为可预期(并行由我自己开 subagent)。
13. 作为 MCP 客户端,我希望解析结果默认保留页面中所有链接 URL 与图片 URL、且不递归展开链接内容,以便溯源与引用。
14. 作为 MCP 客户端,我想 `search` 工具保持既有行为锚定(`type` 默认 `ai`、`count` 钳制 1..50、`freshness` 非法回退 `noLimit`、异常返回可读错误文本),以便稳定调用。
15. 作为部署者,我想通过 `SERVER_URL` 配置服务对外地址,以便提示词模板指向正确的上传端点(本地默认 `localhost:18081`,云部署为公网地址)。
16. 作为部署者,我想通过 `READ_CACHE_TTL` 配置缓存有效期、`READ_TIMEOUT` 配置整体超时兜底,以便按部署场景调参。
17. 作为部署者,我想通过 `MCP_*` env 覆盖工具/参数描述,以便按客户端场景定制模型引导,而不改代码。
18. 作为部署者,我想工具描述 env 缺省时回退到内建描述,以便开箱即用。
19. 作为维护者,我希望缓存对同一 URL 的并发请求去重(只抓一次),以便避免重复抓取与缓存双写竞态。
20. 作为维护者,我希望过期的缓存条目被惰性删除 + 每小时定时兜底清理,以便磁盘与缓存表不无限增长。
21. 作为维护者,我希望抓取失败/错误响应不写入缓存,以便不长期返回坏结果。
22. 作为维护者,我希望 `POST /read` 上传解析不缓存,以便行为简单可预期。
23. 作为使用者,我希望 HTTP 层支持 `X-Read-Timeout` header 控制单次请求超时(REST 直连也可用),以便大文件 REST 调用不被服务端过早掐断。
24. 作为维护者,我希望 `timeout` 预算 clamp 到 180s 后透传给 jina `x-timeout`,以便服务端整体预算与 jina 内部抓取预算对齐。
25. 作为使用者,我想在 README 手册中找到全部路由、上传、配置、缓存与超时的说明,以便自助使用与排障。

## Implementation Decisions

- **全量路由挂载**:`/read` → jina `/`、`/read/<rest>` → `/<rest>`;`/r` 完全同义;任意 method;改写 `req.url` 时保留原始 query string;`ctx.respond=false` 交 jina koaApp;不引入 koa-mount(沿用 `handleRead` 手动改写模式)。`/`、`/health` 仍为本服务 health。
- **bodyParser 分流**:全局 bodyParser 不得吞 `/read/**` 的 multipart body;按 Content-Type 分流(JSON body 留给 search,multipart 放行给 read 上传)。
- **缓存**:一级缓存只缓存解析后 Markdown;键 = `uri(含 query)+ engine`,engine 归一化为 `auto`/`browser`/`curl`;联合唯一约束;TTL `READ_CACHE_TTL`(默认 300)滑动续期;惰性删除 + 每小时定时兜底清理(仅删过期行,不误删并发写入);只缓存成功响应;上传解析不缓存;in-flight 去重粒度 = 缓存键(同键共享进行中 Promise)。缓存层在 HTTP read 层,HTTP 直连与 MCP self-call 共用。
- **MCP `read` 工具**:参数 `uri`(必填,实现层按 scheme 分流:http(s) 抓取、其他返回模板)、`skip`(默认 0,非负)、`length`(默认 5000,1..50000)、`engine`(`auto`/`direct`/`browser`)、`timeout`(正整数 ≤600);返回 `[skip, skip+length)` 纯文本切片;截断时(精确判断 `skip+length < 全文长度`)尾部追加提示;`engine` 映射 `direct`→`X-Engine: curl`、`browser`→`X-Engine: browser`、`auto`→不传。
- **提示词模板**:非 http(s) uri 返回自包含模板(curl 示例 + 逐项参数解释);端点地址经 `config.serverUrl`(`SERVER_URL`,默认 `http://localhost:18081`)渲染;参数对齐 MCP 功能(`x-engine`/`x-retain-links: all`/`x-retain-images: all`);行为锚定:保留全部链接/图片 URL、不递归嵌套解析。
- **timeout 体系**:三层 —— jina 内部抓取(`x-timeout` ≤180s,软,透传)、HTTP 层整体(`X-Read-Timeout` header > env `READ_TIMEOUT` > 90s,硬,超时 504)、MCP 参数(`timeout` ≤600,硬,超时返回可读错误文本);MCP timeout 语义 = 加载 web + 解析整体预算;整体预算 clamp-180 透传为 jina `x-timeout`;timeout 不参与缓存键;缓存命中不消耗预算。
- **search 工具**:行为不变(锚定:type 默认 ai、count 钳制、freshness 回退、异常返回错误文本);不加 timeout 参数。
- **描述 env 化**:`src/config.ts` 建 `mcpDesc` 结构,显式枚举工具与参数描述,类型安全;`createMcpServer` 经 deps 注入 `description`/`describe()`;env 名 `MCP_SEARCH_DESC`/`MCP_SEARCH_TYPE`/`MCP_SEARCH_QUERY`/`MCP_SEARCH_COUNT`/`MCP_SEARCH_FRESHNESS`/`MCP_SEARCH_INCLUDE`(单数)/`MCP_SEARCH_EXCLUDE`、`MCP_READ_DESC`/`MCP_READ_URI`/`MCP_READ_SKIP`/`MCP_READ_LENGTH`/`MCP_READ_ENGINE`/`MCP_READ_TIMEOUT`。
- **配置新增**:`SERVER_URL`、`READ_TIMEOUT`、`READ_CACHE_TTL`;docker-compose 补 env 注释。
- **README 手册化**:介绍/快速开始/配置/API/文件解析(上传)/缓存与超时/开发/参考;文件解析章节与提示词模板内容一致(模板不内嵌"见 README",但章节是权威依据)。
- **MCP self-call**:`read` 工具内部经 `http://127.0.0.1:PORT/r/<uri>` 复用 HTTP 层(带 `X-Read-Timeout`、`X-Engine` header),命中同一缓存。

## Testing Decisions

- **好测试的标准**:只测外部可观测行为(HTTP 契约 / 工具返回文本 / 缓存命中行为),不测内部实现细节。
- **主 seam(一个)**:HTTP 路由层 —— 用 supertest 直接打 koa app(现有先例 `test/search.http.test.js`),mock bocha 与 jina 桥接。覆盖:search 契约、read 路由(query 保留 / `POST` 上传 / 非 http(s) 模板 fallback / 缓存命中与失效 / `X-Read-Timeout` 超时 / health)。
- **纯逻辑单测(非 seam)**:切片、截断提示、模板渲染(`SERVER_URL` 注入)、参数 zod schema、`mcpDesc` env 覆盖 —— 抽为纯函数/结构直接单测,不经 MCP 传输。
- **容器冒烟(不进常规单测)**:MCP streamable/SSE 传输握手、read 工具经真实 MCP 调用、jina 真实抓取、上传解析 header 行为(`docs/smoke-test.md` 扩展)。
- **隔离外部依赖**:bocha fetch、jina 桥接、文件上传在单测中 mock,不依赖真实网络/密钥/容器内 Chrome。

## Out of Scope

- 非 http(s) 协议下载器(file/ftp/s3/对象存储等)及其抽象层(ADR-0006 否决;统一走提示词模板 + 上传解析)。
- MCP 工具 base64/bytes 参数、MCP prompts 机制、上传鉴权/大小限额(维持原汁原味)。
- `cf-browser-rendering` engine(暂保持三枚举)。
- search 工具 timeout 参数、search 描述国际化(env 化已覆盖自定义,国际化未做)。
- 缓存磁盘配额/多级缓存(仅一级缓存 + 定时清理)。

## Further Notes

- 领域术语见 `CONTEXT.md`;ADR-0004~0007 是本 spec 的架构依据;完整定稿见 `.scratch/search-reader-mcp/v7-read-cache-mcp.md`。
- 实现拆分与依赖见 `.scratch/search-reader-mcp/issues/`(每个 ticket 独立文件,按 Blocked by 解耦以支持并行)。
- 实现期需实测:bodyParser 对 `/read/**` multipart 的行为、`req.url` 改写时 query 透传、docker exec 列 jina koaApp 实际路由清单、上传解析对 header 的实际支持。
- 建议实施顺序:config → (cache ‖ search 描述 env ‖ compose) → (route-mount ‖ mcp-read) → readme → smoke-test。
