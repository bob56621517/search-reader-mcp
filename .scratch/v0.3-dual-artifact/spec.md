# Spec: v0.3 双产出物(server 容器 + client 本地 stdio MCP)

**Status:** `ready-for-agent`
**日期:** 2026-08-18
**关联 ADR:** 0008(双产出物架构)、0009(catalog 契约)、0010(本地文件安全边界)、0011(容器生命周期)
**实施顺序:** 见 `.scratch/v0.3-dual-artifact/plan.md`

---

## Problem Statement

本地 Agent 想要搜索与读网页/文件能力,现在只有 docker 容器里的整合服务器(单端口承载 read/search/mcp/sse)。它通过 `/mcp`(streamable HTTP)暴露 `search`、`read` 两个工具,但工具定义不满足 OpenAI 目录要求(两项都缺 `destructiveHint`,schema 声明报告不全),无法直接收录;Agent 要连上它得自己手动启停容器;要读本地文件只能靠"报错即 prompt"引导手动 curl 上传,没有原生的本地文件读取通道。同时仓库是单产出物结构,无法容纳"本地 stdio MCP"这块新的 TS。

## Solution

v0.3 把 search-reader-mcp 重构为**双产出物单仓库**:

- **server**(整合服务器,容器):新增 `GET /catalog` 工具目录端点(desc/hints 单一来源);MCP 工具的四个 hint 全声明、inputSchema 全 zod;`POST /read/<rest>` 也走 read 缓存。保留 `/mcp` 与 `/sse`。
- **client**(本地 stdio MCP):向 Agent 暴露 `search`、`read` 两个工具;工具 desc/hints 启动时从 `/catalog` 拉取,schema 由本地 zod 定义;read 支持 `http(s)` URL 与本地文件绝对路径;代理整合服务器的 HTTP API(统一走 POST);管理容器生命周期——检测到未运行且 docker+配置齐备时静默启动(GHCR 镜像,常驻),缺前置条件时按正常 MCP 失败路径退出,容器常驻不回收。

## User Stories

1. 作为 Agent,我想通过本地 stdio MCP 连接 `search`/`read` 两个工具,以便在一个会话里直接联网搜索和读取网页。
2. 作为 Agent,我想调用 `read(uri=http(s)://…)` 把网页抓取为 Markdown,以便阅读正文。
3. 作为 Agent,我想调用 `read(uri=file:///绝对URI 或绝对 OS 路径)` 读取本地文档解析为 Markdown,以便阅读本地 PDF/Office/网页文件。
4. 作为 Agent,我想 `read` 收到相对路径时得到明确指令文本(请传绝对路径),以便快速修正调用。
5. 作为 Agent,我想调用 `search`(web/ai 两种类型)获得结构化搜索结果,以便回答需要时效性信息的问题。
6. 作为操作者,我想 client 启动时自动检测容器——已运行则静默复用,未运行且 docker + 配置齐备则静默后台启动,以便开箱即用。
7. 作为操作者,我想容器首次拉取镜像较慢时 client 照常启动,期间工具调用返回"容器正在启动(可手动 docker pull)"状态文本,以便不阻塞、可自助加速。
8. 作为操作者,我想 docker 缺失或 `REQUIRED_ENVS`(当前 `[BOCHA_API_KEY]`)缺失时,client 按正常 MCP 失败路径退出、工具不注册、stderr 写清原因,以便明确感知配置问题。
9. 作为操作者,我想 client 启动时从 `/catalog` 拉取工具 desc/hints(server 的 `MCP_*` env 可覆盖 desc),以便工具描述与 server 单一来源同步。
10. 作为操作者,我想 `search`/`read` 在两个 MCP 面(client stdio 与 server `/mcp`)都声明齐全的四个 hint 与 zod inputSchema,以便通过 OpenAI 目录审核。
11. 作为操作者,我想容器由任一方启动后常驻(`--restart unless-stopped`),client 退出不停它,以便跨 session 复用、消除所有权/泄漏 bug。
12. 作为操作者,我想运行时容器挂掉时,工具调用返回"容器未运行"指令文本,以便 Agent 得知如何恢复。
13. 作为开发者,我想 server 与 client 各自独立依赖、互不跨树相对 import,以便各自独立构建/发布、Docker 构建上下文自包含。
14. 作为开发者,我想 `/catalog` 只下发 desc/hints、inputSchema 由 client 自持,以便 client 的 read 调用面(本地文件)不被 server 的 schema 束缚。
15. 作为操作者,我想本地文件读取不设白名单,权限由 MCP host 权限层 + OS 管控,以便 agent 读本地文件成为基本能力。
16. 作为 Agent,我想 client→server 的 read 与 search 统一走 POST,以便与 jina 契约一致(GET|POST 等价,选项可入 body)。
17. 作为 Agent,我想 client 的 `search` 镜像整合服务器的 search 参数(`type/query/count/freshness/include/exclude`),以便行为一致。
18. 作为操作者,我想 server 保留 `/mcp` 与 `/sse`,以便容器仍可被远程(streamable HTTP)直接连接。
19. 作为开发者,我想通过单一主接缝(MCP 协议)测试 client,以便验证 Agent 实际体验到的契约。

## Implementation Decisions

- **双产出物单仓库**:`server/` 为自包含容器项目(Dockerfile、compose、容器 TS、测试、脚本都在其内,Docker 构建 context 即此);`client/` 为本地 stdio MCP 项目。根级不设 Makefile 与 package.json;两项目各自独立依赖、**禁止跨树相对 import**——唯一共享面是 HTTP 契约(`/catalog` 下发工具元数据)。(ADR-0008)
- **`GET /catalog`**:返回 `{tools:[{name, description, annotations}]}`;annotations 四项显式(含 `destructiveHint`);desc 复用 server 的 `MCP_*` env 化描述;inputSchema 不下发。(ADR-0009)
- **server MCP 工具修整**:`search`/`read` 补 `destructiveHint:false`(四项 hint 全声明),确认 inputSchema 由 zod 声明。
- **read 缓存扩展**:`POST /read/<rest>` 与 GET 等价接入 read 缓存(jina 契约 GET|POST 等价;缓存 key 用 url + engine)。
- **server 保留 `/mcp` 与 `/sse`**,供远程直连;client 走 stdio 不经过它们。
- **client 工具定义**:启动时拉 `/catalog` 取 desc/hints;inputSchema 本地 zod——`search` 镜像整合服务器参数(`type/query/count/freshness/include/exclude`),`read` 为 `{uri, skip, length, engine, timeout}`。(ADR-0009)
- **client read 行为**:`uri=http(s)://…` → `POST /read/<url>`(jina 透传,选项入 body);`uri=file:///绝对URI` 或绝对 OS 路径 → client 读取本地文件后 `POST /read`(multipart 上传)解析;相对路径 → 指令文本不解析;`skip`/`length` 在 client 本地切片。(ADR-0010)
- **client search 行为**:`POST /search/<type>` JSON body。
- **client 生命周期**(ADR-0011):`GET :18081/health` 命中 → 复用;未命中 → 检查 `docker info` 与 `REQUIRED_ENVS`——齐备则后台 `docker run -d` 拉取 GHCR 镜像(`ghcr.io/bob56621517/search-reader-mcp:v0.3.0`,`--restart unless-stopped`,卷 `~/.search_reader_mcp`,透传 `BOCHA_API_KEY`),启动窗口期后台轮询 /health、工具调用返回"正在启动"状态;缺失 → stderr 报错 + 正常 MCP 失败路径退出(工具不注册)。容错:`docker run` 报 name in use → `docker start`;启动后回探 /health 定成败。容器**不回收**(常驻基础设施)。
- **`REQUIRED_ENVS` 设计为可扩展列表**(当前 `[BOCHA_API_KEY]`),后续加必填项只改列表不改逻辑。
- **client 运行时**:Node + tsc(与 server 一致);从仓库运行(`node client/dist/index.js`),npm 发布留后续。
- **版本**:server 与 client 同 `0.3.0`;GHCR 镜像 tag `v0.3.0`(另有 `latest`);client 提示词中的镜像引用对齐该 tag。
- **统一走 POST**:client→server 的 read/search 一律 POST(jina 契约 GET|POST 等价,POST 可带选项 body)。

## Testing Decisions

- **主接缝(client):MCP 协议边界。** 官方 `@modelcontextprotocol/sdk` 的 Client 连接真实 client(stdio,进程内),调用 `tools/list` 与 `tools/call` 断言返回结果。这一接缝覆盖 client 的 CLI→server→工具→外部依赖的完整接线,正是 Agent 体验到的契约边界。判定标准:给定工具输入,Agent 观察到的 `tools/list` 内容与 `tools/call` 返回值符合契约;不测内部实现细节。
- **外部依赖在注入点打桩(不新增接缝):**
  - **server HTTP**(`/read`、`/search`、`/catalog`):在 client 的 HTTP 边界注入假客户端,不触真实 server。
  - **docker**(`docker info` / `docker run` / `docker start` / health 轮询):在 client 的 docker 执行边界注入假命令执行器。
  - **本地文件读取**:用本地临时 fixture 文件,不打真实用户路径。
- **server 接缝(既有):HTTP 契约层。** 复用 `node:test` + supertest 直打整合服务器(`createApp`)验证 `GET /catalog` 返回契约与 `POST /read/<rest>` 缓存行为;纯逻辑测试验证 hints 配置;扩展 MCP 冒烟脚本的 `tools/list` 断言四项 hint 全声明。
- **被测模块**:client(search/read handler、catalog 拉取、生命周期全链路含失败语义)、server(`/catalog`、POST 读缓存、hints 合规)。
- **先例**:server 现有 HTTP 契约测试与纯逻辑测试;client 协议缝测试沿用官方 SDK Client/Server 进程内 stdio 对测模式。

## Out of Scope

- **client 的 npm 发布**与 web(streamable HTTP)传输(本地 mcp 只 stdio)。
- **容器回收**:容器常驻不回收;回收是未来容器内功能。
- **相对路径本地读取**(强制绝对路径,ADR-0010)。
- **本地文件白名单/沙箱**(安全边界 = MCP host 权限 + OS)。
- **server `/mcp` 的 schema 输出改造**(catalog 不下发 schema,由 client 自持)。
- 镜像构建优化、多架构、上传鉴权/大小限额(沿用现状)。
- roadmap 后续项:国际化(0)、搜索引擎抽象(1)、无 MCP 纯 skill(2)、claudecode 插件化(3)。
- **agent-web-mcp 仓库内容迁移**(该仓库废弃)。

## Further Notes

- 镜像已发布:`ghcr.io/bob56621517/search-reader-mcp`(tags `latest`、`0.2.0`);v0.3 用 tag `v0.3.0`。
- 实施在 `dev-0.3.0` 分支,全部功能完成才合入 main。
- 与 ADR-0007 对照:整合服务器不读宿主文件、路径穿越面为 0 不变;本地文件读取仅存在于 client(ADR-0010)。
- 决策链:本 spec 由 `/grill-with-docs` 定稿(ADR-0008~0011),实施顺序见 `plan.md`。
