# search-reader-mcp

扩展 Jina Reader 镜像的项目:在 Jina Reader 基础上添加自定义搜索(bocha)与 MCP 服务。v0.3 起为双产出物:**server**(整合 HTTP 服务器,一个端口承载 read、search、mcp、sse、catalog)+ **client**(本地 stdio MCP,代理 server 的 HTTP API,向 Agent 暴露 search/read)。

## Language

**整合服务器 (Integrate Server)**:
v0.3 双产出物中的 server 端:单一 HTTP 服务器,在一个端口上同时承载 read、search、mcp、sse、catalog 端点,取代 jina 镜像默认启动的 reader 服务;容器化部署于 `server/` 目录。
_Avoid_: gateway、aggregator、多端口服务

**client (本地 stdio MCP)**:
v0.3 双产出物中的另一端:运行在宿主机、经标准输入输出(stdio)与 Agent 通信的 MCP 服务,对外暴露与 server 一致的 `search`、`read` 两个工具;代理 server 的 HTTP API,并管理 server 容器的生命周期(启动/复用/回收)。
_Avoid_: 本地代理、stdio 服务

**read**:
把资源转换为 LLM 友好的 Markdown 正文的能力,底层进程内复用 jina 镜像的抓取模块。入参统一为 `uri`:http(s) URL 走 URL 抓取(HTTP 形态为 `/read/<url>`,`GET`/`POST` 等价,POST 可带选项 body);本地文件以 `file:///` 绝对 URI 或绝对 OS 路径传入(仅 client 支持——由 client 读取并 multipart 上传解析;server 自身不读宿主文件,非 http(s) 一律返回提示词模板引导)。相对路径一律不接受,返回指令文本。
_Avoid_: 爬取、reader 服务

**search**:
基于 bocha 的联网搜索能力,分两种类型:web 搜索(返回网页结果列表)与 ai 搜索(AI 语义搜索,含总结、模态卡、追问);HTTP 形态为 GET 路径即 query(`/search/ai/<query>`、`/search/web/<query>`,`/s/<query>` 是 ai 快捷方式),GET/POST 交叉(POST 为 JSON body)。
_Avoid_: 联网、泛指的 web search

**bocha**:
本项目选定的搜索提供商,提供 web-search 与 ai-search 两个 API;API 密钥来自环境变量 `BOCHA_API_KEY`。
_Avoid_: 搜索引擎、搜索 API

**catalog (工具目录)**:
server 暴露的 HTTP 端点,返回工具定义元数据(tools 列表:name / description / annotations);client 启动时从它拉取工具描述与 hints,保证 desc 单一来源(server 的 `MCP_*` env 可覆盖)。inputSchema 由 client 自持,不从 catalog 下发。
_Avoid_: 工具清单、describe 端点

**mcp 端点**:
基于官方 SDK、以 Model Context Protocol 暴露的服务端点,走 streamable HTTP 传输,对外暴露 `search` 与 `read` 两个工具;供 server 独立被远程连接使用,client 走 stdio 不经过它。
_Avoid_: AI 工具、plugin

**sse 端点**:
MCP legacy SSE 传输端点,用于兼容不支持 streamable HTTP 的老版 MCP 客户端;与 mcp 端点共享同一工具注册表。
_Avoid_: 泛指的 SSE 流式接口

**持久化目录**:
部署后宿主机 `~/.search_reader_mcp/` 目录,外挂 sqlite 缓存库与配置文件,由 compose 挂载进容器。
_Avoid_: data 目录、volume
