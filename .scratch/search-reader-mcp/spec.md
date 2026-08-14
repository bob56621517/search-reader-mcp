# search-reader-mcp — 整合服务器 spec

Status: ready-for-agent

## Problem Statement

现有 jina-reader 镜像只提供"URL→可读文本"的单一抓取服务,没有自定义搜索能力,也不接入 MCP 生态。用户需要在这个镜像基础上扩展一个**单端口整合 HTTP 服务器**:在一个端口上同时提供 jina 的读取能力、bocha 联网搜索、以及供 AI 客户端调用的 MCP 服务,并且要直接复用镜像已有的环境(Node 24 + Chrome + 依赖),而不是另起炉灶。

## Solution

交付一个"扩展 jina-reader 镜像"的工程:以 jina 镜像为基座,新增一个整合服务器进程,**覆盖镜像默认启动的 crawl.js**。服务器监听单一端口(18081,容器内外一致),路径前缀路由:

- `read/`(别名 `r/`)— 进程内复用 jina 抓取模块,URL→Markdown
- `search/web`、`search/ai`(别名 `s/web`、`s/ai`)— bocha 搜索,返回结构化 JSON
- `mcp/` — MCP 服务(streamable HTTP)
- `sse/` — MCP legacy SSE 传输(兼容老客户端),配套 `POST /messages`

MCP 层暴露两个工具:`search`(type 默认 `ai`,web/ai 合一)与 `read`(仅 url)。配置走环境变量,默认值集中在 `docker-compose.yml`;sqlite 缓存先建库、暂不接入。开发环境直接使用该镜像。

## User Stories

1. 作为使用者,我想通过 `GET /read/<url>`(路径即 url)把网页/PDF 转成 Markdown,以便 LLM 或脚本直接消费正文。
2. 作为使用者,我想用 `GET /r/<url>` 这个短别名访问读取能力,以符合 jina 的 r./s. 习惯并少打几个字。
3. 作为使用者,我想通过 `GET /search/web/<query>`(query 直接在路径中)得到 bocha 网页搜索结果(结构化 JSON:标题/链接/站点/摘要),以便程序化处理。
4. 作为使用者,我想用 `GET /search/ai/<query>` 或其快捷方式 `GET /s/<query>` 得到 AI 语义搜索结果(总结答案+参考网页+模态卡+追问),以便直接获得综述型答案。
5. 作为搜索调用方,我想用 `POST /search/ai`、`POST /search/web`、`POST /s` 传标准 JSON body(query 与高级参数),以便复杂参数场景下标准化调用。
6. 作为搜索调用方,我想传入 `count`、`freshness`、`include`、`exclude` 等可选参数,以便控制结果条数与范围;`count` 越界会被钳制到 1..50,freshness 非法值回退到 `noLimit`。
7. 作为搜索调用方,当 `query` 缺失或空时,我希望收到 400 类错误提示,而不是静默失败。
8. 作为搜索调用方,当 bocha API 返回非 200 或响应无法解析时,我希望收到包含 code/msg 的可读错误。
9. 作为 AI 客户端,我想通过 `POST /mcp` 用 streamable HTTP 连接 MCP 服务,以便在 Claude Code 等工具里调用 `search` 与 `read` 工具。
10. 作为 AI 客户端,我想调用 `search` 工具(默认 AI 语义搜索),并可选 `type="web"` 切换到裸网页列表,以便灵活获取搜索结果。
11. 作为 AI 客户端,我想调用 `search` 工具时看到模型友好的格式化文本(带 AI 总结、模态卡、编号参考网页、追问问题),并被告知把来源渲染为超链接。
12. 作为 AI 客户端,我想调用 `read` 工具传入一个 http(s) URL,得到该页面的 Markdown 正文。
13. 作为老版 MCP 客户端,我想通过 `GET /sse` 建立 SSE 事件流、向 `/messages` POST 请求,以便不升级也能继续使用本服务。
14. 作为部署者,我想通过 `docker compose up` 一键启动服务,容器监听 18081、外部同样通过 18081 访问。
15. 作为部署者,我想用宿主已有的 `BOCHA_API_KEY` 环境变量注入密钥,不在任何地方硬编码。
16. 作为部署者,我想让 sqlite 库与配置文件持久化在宿主 `~/.search_reader_mcp/`,以便容器重建后数据仍在。
17. 作为部署者,我想在 `docker-compose.yml` 里集中修改端口、URL、路径等默认值,而不必改代码。
18. 作为开发者,我想在基于 jina 镜像的开发容器里用 `tsc --watch` + `node --watch` 热重载,改代码即生效。
19. 作为开发者,我想构建镜像后其默认启动就是整合服务器(覆盖原 crawl.js),无需额外命令。
20. 作为维护者,当未配置 `BOCHA_API_KEY` 时,我希望 search 能力明确报错提示,而不是崩溃或返回垃圾数据。
21. 作为维护者,我希望 sqlite 缓存基础设施在首次启动时自动建库,后续接入缓存无需改部署。

## Implementation Decisions

- **整合服务器(单体 HTTP 服务)**:一个 koa 进程,单端口监听,路径分发 `read/`(别名 `r/`)、search(`/search/ai/<query>` 与 `/search/web/<query>` 路径即 query,快捷方式 `/s/<query>` 即 ai;GET 同时支持 query string 高级参数,POST JSON body,GET/POST 交叉)、`mcp/`、`sse/`。覆盖镜像默认启动,启动时不调用 jina 自带的 listen。
- **read 复用 jina 抓取模块(ADR-0003)**:进程内 resolve 镜像编译产物 `build/stand-alone/crawl.js` 的 `CrawlStandAloneServer`,取它的 `koaApp` 完整中间件栈挂到 `/read`(及 `/r`)前缀,复用其 Chrome 抓取、反爬对抗、PDF 解析;请求改写为 jina 期望的路径形态。URL 来自查询参数 `url`。
- **bocha 客户端(能力层,ADR-0002)**:独立实现,照搬参考实现 `xyz-mcp-hub` 的 `BochaClient` 语义到 Node——两个端点 `/v1/web-search` 与 `/v1/ai-search`,HTTP 客户端用内置 `fetch`;参数透传(query 必填、count 钳制 1..50、freshness 枚举或日期范围、布尔参数透传、include/exclude);base-url 默认 `https://api.bochaai.com`、`Authorization: Bearer <key>`;非 200/解析失败抛可读错误。返回结构化 VO(WebPage / AiSearchResult / ModalCard)。
- **搜索工具层**:预设默认值(count=20、freshness=noLimit、web 场景 summary=true、ai 场景 answer=true),把 VO 格式化为模型友好文本(参考实现 BochaTools 的格式)。
- **MCP 服务**:基于官方 `@modelcontextprotocol/sdk`。`/mcp` 用 `StreamableHTTPServerTransport`(streamable HTTP,单一会话先启用);`/sse` 用 `SSEServerTransport`(legacy,GET 建流 + POST `/messages`),两者共享同一工具注册表。工具:`search`(type 默认 `ai`)与 `read`(url)。
- **read 工具与 HTTP read 路由**:共享同一读取能力;MCP read 工具内部走本服务 `read/` 路由。
- **sqlite 缓存(先建库不接缓存)**:用 Node 24 内置 `node:sqlite`(零依赖),首次启动建 `meta` 表占位;库文件默认落于持久化数据目录。
- **配置**:环境变量注入,默认值集中定义于 `docker-compose.yml`:`PORT=18081`、`HOST=0.0.0.0`、`BOCHA_API_KEY`(透传宿主)、`BOCHA_URL`、`JINA_APP=/app`;数据目录外挂宿主 `~/.search_reader_mcp` → 容器 `/app/extension/data`。
- **工程布局**:TypeScript(CommonJS,对齐镜像工程);仓库根即工程,镜像内 `/app/extension`;额外依赖(MCP SDK 等)补装进镜像 `/app/node_modules` 共享树;构建用镜像自带 `typescript`。
- **部署**:Dockerfile `FROM ghcr.io/jina-ai/reader:latest` 并改 `CMD` 指向整合服务器入口;docker-compose 映射 `18081:18081`、透传 `BOCHA_API_KEY`、挂载持久化目录。开发用 `dev.sh`(`tsc --watch` + `node --watch`)。

## Testing Decisions

- **好测试的标准**:只测外部可观测行为(HTTP 契约:状态码、JSON 结构、错误信息),不测内部实现细节。
- **测试接缝(单一)**:整合服务器的 HTTP 路由层,用 supertest(镜像自带)直接打 koa app。重点覆盖:
  - `search/web` 与 `search/ai` 的契约:`query` 必填校验、`count` 钳制、`freshness` 回退、include/exclude 透传、成功响应的 JSON 结构(WebPage / AiSearchResult 字段)。
  - 错误路径:bocha 返回非 200、响应不可解析、未配置 `BOCHA_API_KEY` 时的行为。
- **隔离外部依赖**:bocha 的 `fetch` 在测试中 mock,不依赖真实网络与真实密钥。
- **容器内冒烟(不进常规单测)**:`read/` 的 jina 抓取依赖容器内 Chrome 渲染,`mcp/` 与 `sse/` 为协议握手,由开发/发布前在容器内冒烟验证。
- **先例**:镜像自带 supertest 与 c8 测试基础设施,可复用作测试运行器。

## Out of Scope

- `read` 的高级抓取参数(targetSelector、waitUntil、maxImages、ignoreSelector 等)。
- `read` 的 `file://` 本地文件支持。
- `read` 的 SSRF 防护。
- sqlite 缓存的实际接入(search/read 结果缓存与 TTL)。
- serper 等其他搜索源接入。
- MCP 多会话(session 管理)、OAuth。
- 与官方 jina reader HTTP 接口的向后兼容。

## Further Notes

- 开发环境直接使用 jina 镜像,代码编辑/构建/运行都在容器内完成,避免环境漂移。
- 参考实现 `xyz-mcp-hub` 的 `BochaClient`/`BochaTools` 提供了 bocha 客户端与工具层的完整范本,照搬其语义。
- `BOCHA_API_KEY` 宿主环境已有值,compose 直接透传。
- 领域术语与架构决策见 `CONTEXT.md` 与 `docs/adr/0001-0003`。
