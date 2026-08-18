# ADR-0008: v0.3 双产出物架构(server 容器 + client 本地 stdio MCP)

v0.3 起本仓库从单产出物(容器)重构为**双产出物单仓库**:`server/` 是自包含的容器项目(Dockerfile、compose、容器 TS 源码、测试、脚本都在其内,作为 Docker 构建 context),`client/` 是运行在宿主机的本地 stdio MCP(代理 server 的 HTTP API,向 Agent 暴露 `search`/`read`)。`agent-web-mcp` 仓库(原生 Bun 聚合 MCP)废弃不再演进。根级不设 Makefile 与根级 package.json;两个项目各自独立依赖、**互不跨树相对 import**,唯一共享面是 HTTP 契约(`/catalog` 下发工具元数据)。原因是两块 TS 放一个仓库但产出两个东西,边界要显式化:server 可独立构建/发布(GHCR 镜像),client 可独立运行;跨树 import 会破坏 Docker 构建上下文的自包含性,故列为禁令。
