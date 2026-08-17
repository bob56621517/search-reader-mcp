# search-reader-mcp

扩展 Jina Reader 镜像的项目:在 Jina Reader 基础上添加自定义搜索(bocha)与 MCP 服务,以单个整合 HTTP 服务器在一个端口上对外提供 read、search、mcp、sse 能力。

## Language

**整合服务器 (Integrate Server)**:
本项目交付的单一 HTTP 服务器,在一个端口上同时承载 read、search、mcp、sse 四个端点,取代 jina 镜像默认启动的 reader 服务。
_Avoid_: gateway、aggregator、多端口服务

**read**:
把资源转换为 LLM 友好的 Markdown 正文的能力,底层进程内复用 jina 镜像的抓取模块;HTTP 形态为 GET `/read/<url>`(别名 `/r/<url>`,路径即 url)与 POST `/read`(multipart file 上传解析)。非 http(s) 资源不直接抓取,返回提示词模板引导走上传解析。
_Avoid_: 爬取、reader 服务

**search**:
基于 bocha 的联网搜索能力,分两种类型:web 搜索(返回网页结果列表)与 ai 搜索(AI 语义搜索,含总结、模态卡、追问);HTTP 形态为 GET 路径即 query(`/search/ai/<query>`、`/search/web/<query>`,`/s/<query>` 是 ai 快捷方式),GET/POST 交叉(POST 为 JSON body)。
_Avoid_: 联网、泛指的 web search

**bocha**:
本项目选定的搜索提供商,提供 web-search 与 ai-search 两个 API;API 密钥来自环境变量 `BOCHA_API_KEY`。
_Avoid_: 搜索引擎、搜索 API

**mcp 端点**:
基于官方 SDK、以 Model Context Protocol 暴露的服务端点,走 streamable HTTP 传输,对外暴露 `search` 与 `read` 两个工具。
_Avoid_: AI 工具、plugin

**sse 端点**:
MCP legacy SSE 传输端点,用于兼容不支持 streamable HTTP 的老版 MCP 客户端;与 mcp 端点共享同一工具注册表。
_Avoid_: 泛指的 SSE 流式接口

**持久化目录**:
部署后宿主机 `~/.search_reader_mcp/` 目录,外挂 sqlite 缓存库与配置文件,由 compose 挂载进容器。
_Avoid_: data 目录、volume
