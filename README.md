# search-reader-mcp

扩展 [Jina Reader](https://jina.ai/reader) 镜像的项目:在 Jina Reader 基础上添加**自定义搜索(bocha)** 与 **MCP 服务**。v0.3 起为**双产出物单仓库**:`server/`(整合服务器容器)承载全部搜索/读取能力,`client/`(本地 stdio MCP)把这两项能力以 MCP 工具形式带给 Agent,并托管容器的生命周期。

## 目录

- [双产出物架构](#双产出物架构)
- [快速开始](#快速开始)
  - [client(推荐,Agent 本地 MCP)](#client推荐agent-本地-mcp)
  - [纯 server 容器(远程 HTTP 直连)](#纯-server-容器远程-http-直连)
- [配置](#配置)
  - [server(容器)环境变量](#server容器环境变量)
  - [client 环境变量](#client-环境变量)
- [MCP 工具(search / read)](#mcp-工具search--read)
- [HTTP API(server 直连)](#http-apiserver-直连)
  - [read(URL → Markdown)](#readurl--markdown)
  - [search(bocha)](#searchbocha)
  - [health](#health)
- [文件解析(上传)](#文件解析上传)
- [缓存与超时](#缓存与超时)
- [开发](#开发)
- [目录结构](#目录结构)
- [参考](#参考)

## 双产出物架构

v0.3 起本仓库重构为**双产出物单仓库**(ADR-0008):

| 产出物 | 位置 | 形态 | 职责 |
| --- | --- | --- | --- |
| **server** | `server/` | 整合服务器**容器**(Dockerfile + compose,单端口 18081) | 全部搜索/读取能力:`/read`(jina 抓取/上传解析)、`/search`(bocha)、`/catalog`(工具元数据)、`/mcp`、`/sse`、`/health`;进程内复用 jina 镜像的 Chrome 抓取与运行环境 |
| **client** | `client/` | **本地 stdio MCP**(Node 进程,跑在宿主) | 向 Agent 暴露 `search`/`read` 两个 MCP 工具:代理 server 的 HTTP API(统一走 POST);原生读取本地文件(`file:///` 绝对 URI / 绝对 OS 路径)后上传解析;检测并托管容器生命周期(已运行则复用,未运行且 docker+配置齐备则静默后台启动) |

```
┌────────────────────────────── 宿主 ──────────────────────────────┐
│  Agent / MCP host(Claude Code 等)                                │
│        │ stdio(MCP 协议)                                          │
│        ▼                                                         │
│  client(search-reader-mcp-client)          ┌──────────────────┐  │
│  node client/dist/index.js                 │  server 容器      │  │
│  ┌────────────────────────────────────┐    │  (ghcr.io/…:v0.3.0)│  │
│  │ 工具 search / read                 │◄───┤  ┌──────────────┐ │  │
│  │ desc/hints ← /catalog(ADR-0009)    │HTTP│  │ /read /search │ │  │
│  │ 本地文件读取 + 切片(ADR-0010)       │    │  │ /catalog      │ │  │
│  │ 容器生命周期(ADR-0011)             │    │  │ /mcp /sse     │ │  │
│  └────────────────────────────────────┘    │  └──────────────┘ │  │
│                                            │  复用 jina Chrome  │  │
│                                            └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- **唯一共享面是 HTTP 契约**(`/catalog` 下发工具元数据);两个项目各自独立依赖、**互不跨树相对 import**,各自独立构建/发布(server → GHCR 镜像,client → 仓库内直接运行)。
- 连接方式二选一:Agent 在本地用 **client**(stdio);或远程/集成环境直连 **server** 的 `/mcp`(streamable HTTP)或 `/sse`(legacy SSE)。两者工具定义一致,但 `read` 的本地文件调用面只在 client(见 [MCP 工具](#mcp-工具search--read))。

## 快速开始

### client(推荐,Agent 本地 MCP)

把 `search`(联网搜索)与 `read`(网页/本地文件 → Markdown)以 MCP 工具形式暴露给本地 Agent;client 会自动检测并启动所需的 server 容器。

**前提**(任一项缺失,client 按正常 MCP 失败路径退出、工具不注册,详见[启动失败提示](#启动失败提示)):

| 项 | 说明 |
| --- | --- |
| Node.js | ≥ 18(client 运行环境) |
| Docker | daemon 运行中(client 依赖它启动/复用容器) |
| `BOCHA_API_KEY` | 搜索必需;需在 client 进程环境里设置(client 启动时校验,启动容器时透传) |

**安装构建(一次性,一条命令)**:

```bash
cd client && npm install && npm run build
```

**配置 MCP host**(Claude Code 在 `.mcp.json`;其他 host 类似):

```json
{
  "mcpServers": {
    "search-reader-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<本仓库路径>/client/dist/index.js"],
      "env": { "BOCHA_API_KEY": "sk-..." }
    }
  }
}
```

**首次使用**:

1. 配置好后重启 MCP host / 开启新会话 → client 以 stdio 启动。
2. client 检测 `:18081/health`:容器已在运行则静默复用;未运行且 docker + 配置齐备则**后台静默启动**容器(`docker run -d --name search-reader-mcp --restart unless-stopped -p 127.0.0.1:18081:18081 -e BOCHA_API_KEY -v ~/.search_reader_mcp:/app/extension/data ghcr.io/bob56621517/search-reader-mcp:v0.3.0`,镜像默认已发布;如未拉取会先 pull)。client 启动的容器**仅绑定本机 `127.0.0.1`**(安全最小面);远程/多机直连请改用 [纯 server 容器](#纯-server-容器远程-http-直连)(compose 绑定 `0.0.0.0`)。
3. 首次拉镜像较慢时 client **照常启动**,期间工具调用返回「容器正在启动,可手动 `docker pull` 加速」;容器就绪后自动恢复。
4. 容器由任一方启动后**常驻**(`--restart unless-stopped`),退出 client 不会停它;停止用 `docker stop search-reader-mcp`。

验证:在 host 里调用 `search(query="hello world")` 或 `read(uri="https://example.com")` 即可。

#### 启动失败提示

client 启动失败时向 **stderr** 写明原因并以退出码 1 结束(工具不注册),典型场景:

| 场景 | stderr 提示(示意) | 处理 |
| --- | --- | --- |
| Docker 未安装 / daemon 未运行 | `启动失败:docker 不可用(docker info 退出码 1):…` | 安装并启动 Docker Desktop 后重试 |
| 缺必填配置 | `启动失败:缺少必填环境变量: BOCHA_API_KEY` | 在 client 进程环境设置 `BOCHA_API_KEY` |
| `docker run` 失败(非 name-in-use / 非超时) | `启动失败:docker run 失败(退出码 N):…` | 按 stderr 明细处理(如端口占用改 `SEARCH_READER_MCP_PORT`) |

容器已存在但停止(如手动 `docker stop` 过)时,client 会 `docker start` 复用,不重复创建。运行时容器挂掉,工具调用返回「容器未运行,请 `docker start search-reader-mcp`」指令文本,不自动重启。

### 纯 server 容器(远程 HTTP 直连)

不需要本地 MCP 工具时,可只跑 server 容器并直连其 HTTP/MCP 端点(可在 `server/` 目录内构建运行):

```bash
cd server
docker compose up -d --build search-reader-mcp   # 前提:宿主已有 BOCHA_API_KEY
# 就绪后:http://localhost:18081
```

> **就绪**:容器内 headless Chrome 启动**不稳定且较慢**(常遇 jina 内部 puppeteer 10s 超时,进程退出后由 `restart: unless-stopped` 自动拉起,通常 1-2 次后成功),**需 30-60s**,以 `curl http://localhost:18081/health` 返回 200 为准。

也可用 `docker run`:

```bash
docker build -t search-reader-mcp .     # 在 server/ 目录内
# 显式设 PORT=18081:jina 基础镜像自带 PORT=8080,不设则容器内监听 8080(与 -p 映射错位)
docker run -d --name srm -p 18081:18081 -e PORT=18081 -e BOCHA_API_KEY search-reader-mcp
```

远程直连时按需接入 `/mcp`(streamable HTTP,见 [MCP 工具连接方式](#连接方式))。

## 配置

### server(容器)环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `18081` | 监听端口(容器内外一致) |
| `HOST` | `0.0.0.0` | 监听地址 |
| `JINA_APP` | `/app` | jina 镜像应用根目录 |
| `BOCHA_API_KEY` | — | **必填**(搜索);开发/compose 共用标准环境变量 |
| `BOCHA_URL` | `https://api.bochaai.com` | bocha API base-url |
| `SEARCH_READER_MCP_DATA` | `/app/extension/data` | 持久化数据目录(compose 外挂宿主 `~/.search_reader_mcp/`) |
| `SQLITE_PATH` | `<dataDir>/cache.db` | sqlite 缓存库路径 |
| `LOG_DIR` | `<dataDir>/.log` | 日志目录(按天滚动) |
| `READ_CACHE_TTL` | `600` | read 缓存 TTL(秒,默认 10 分钟),命中后滑动续期;见 [缓存与超时](#缓存与超时) |
| `READ_TIMEOUT` | `90` | HTTP 层整体超时兜底(秒),超时 504;见 [缓存与超时](#缓存与超时) |
| `SERVER_URL` | `http://localhost:18081` | 服务端对外地址,用于上传解析提示词模板渲染;云部署改为公网地址 |
| `MCP_*` | 内建描述 | MCP 工具/参数描述 env 覆盖,见下 |

**持久化**:sqlite 库、缓存文件(`<dataDir>/read-cache/`)与 `.log/` 日志外挂宿主 `~/.search_reader_mcp/`,容器重建后数据仍在。默认值集中在 `server/compose.yml`,按需手工修改。

**MCP 描述 env 化(`MCP_*`)**:工具与参数描述可经环境变量覆盖,缺省为内建描述。模式:`MCP_<TOOL>_DESC` = 工具描述,`MCP_<TOOL>_<PARAM>` = 参数描述;env 有值即覆盖,未设置沿用内建。

| env | 对应 |
| --- | --- |
| `MCP_SEARCH_DESC` | `search` 工具描述 |
| `MCP_SEARCH_TYPE` / `MCP_SEARCH_QUERY` / `MCP_SEARCH_COUNT` / `MCP_SEARCH_FRESHNESS` / `MCP_SEARCH_INCLUDE`(单数)/ `MCP_SEARCH_EXCLUDE` | `search` 各参数 |
| `MCP_READ_DESC` | `read` 工具描述 |
| `MCP_READ_URI` / `MCP_READ_SKIP` / `MCP_READ_LENGTH` / `MCP_READ_ENGINE` / `MCP_READ_TIMEOUT` | `read` 各参数 |

### client 环境变量

client(本地 stdio MCP)配置;除下表外,`REQUIRED_ENVS`(当前 `[BOCHA_API_KEY]`,可扩展列表)为代码内固定的启动前置校验,不可经 env 关闭。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_URL` | `http://localhost:18081` | 整合服务器地址(client 代理的目标) |
| `SEARCH_READER_MCP_DOCKER` | `docker` | docker 可执行文件(测试可指向假脚本) |
| `SEARCH_READER_MCP_CONTAINER` | `search-reader-mcp` | 容器名(docker run `--name`) |
| `SEARCH_READER_MCP_IMAGE` | `ghcr.io/bob56621517/search-reader-mcp:v0.3.0` | 要启动/复用的镜像 |
| `SEARCH_READER_MCP_PORT` | `18081` | 宿主映射端口(映射容器内 18081) |
| `SEARCH_READER_MCP_DATA` | `~/.search_reader_mcp` | 宿主数据卷绝对路径(docker run `-v`) |
| `SEARCH_READER_MCP_HEALTH_TIMEOUT_MS` | `3000` | 健康探测超时(ms) |
| `SEARCH_READER_MCP_HEALTH_INTERVAL_MS` | `2000` | 后台轮询 `/health` 间隔(ms) |
| `SEARCH_READER_MCP_DOCKER_RUN_TIMEOUT_MS` | `8000` | `docker run` 判定超时(ms):超过视为正在拉镜像,转为后台观察 |
| `SEARCH_READER_MCP_STARTUP_WINDOW_MS` | `600000` | 启动窗口(ms):starting 后超过仍未健康视为容器不可用(down) |
| `SEARCH_READER_MCP_CATALOG_TIMEOUT_MS` | `5000` | `/catalog` 拉取超时(ms) |
| `SEARCH_READER_MCP_HTTP_TIMEOUT_MS` | `120000` | 代理 read/search 的 HTTP 调用超时(ms) |

## MCP 工具(search / read)

MCP 工具统一暴露 `search`(联网搜索)与 `read`(网页/文件 → Markdown 切片)。

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `search` | `type`(默认 `ai`,可 `web`)、`query`、`count`、`freshness`、`include`、`exclude` | 格式化文本:AI 总结/模态卡/编号网页来源/追问 |
| `read` | `uri`、`skip`、`length`、`engine`、`timeout` | 远程网页/本地文件 → Markdown 切片,支持分片续读 |

两个工具的**四项 hint 全声明**且 `inputSchema` 由 zod 声明(满足 OpenAI 目录要求):`readOnlyHint:true`、`idempotentHint:true`、`openWorldHint:true`、`destructiveHint:false`。工具级 desc/hints 的单一来源是 server 的 `/catalog`(ADR-0009);`search` 的 desc 严格取 `/catalog`,`read` 的 desc 因 client 调用面不同(支持本地文件)由 client 自持(ADR-0010)。

### 连接方式

| 方式 | 端点/协议 | 适用 |
| --- | --- | --- |
| **client**(推荐) | stdio(本地进程) | 本地 Agent;含容器生命周期托管与**本地文件原生读取** |
| server `/mcp` | streamable HTTP:JSON-RPC,**无状态模式**(不生成/不要求 `Mcp-Session-Id`,每次请求独立,天然支持多客户端) | 远程/集成环境直连 server |
| server `/sse` | legacy SSE:`GET /sse` 建流,`POST /messages` 发请求(连接级会话,每连接独立) | 兼容老客户端 |

远程直连 server 的 Claude Code 接入示例:

```json
{
  "mcpServers": {
    "search-reader-mcp": {
      "type": "http",
      "url": "http://localhost:18081/mcp"
    }
  }
}
```

### `read` 工具参数

| 参数 | 类型 | 默认 | 校验 |
| --- | --- | --- | --- |
| `uri` | string | 必填 | 见下方「uri 分流」 |
| `skip` | int | `0` | 非负;跳过开头字符数,用于分片续读 |
| `length` | int | `5000` | `1..50000`;返回切片长度,越界 schema 拒绝 |
| `engine` | enum | `auto` | `auto`/`direct`/`browser`(暂不含 `cf-browser-rendering`) |
| `timeout` | int(秒) | 见下 | 正整数,≤600 |

**uri 分流(经 client 调用时,ADR-0010)**:

| uri 形式 | 行为 |
| --- | --- |
| `http(s)://…` | 由 server 直接抓取 → Markdown |
| `file:///` 绝对 URI 或绝对 OS 路径 | client 本地读取文件后经 `POST /read`(multipart)上传解析 → Markdown;**不设白名单目录,安全边界 = MCP host 权限层 + OS 权限兜底** |
| 相对路径 / 无法识别的 scheme | 返回指令文本不解析(提示传绝对路径) |

> 直连 server `/mcp` 时,`read` 遇到**非 http(s) uri** 一律返回可执行的上传引导模板(服务端不读宿主文件,ADR-0007);本地文件原生读取只在 client。

`read` 行为要点:

- 返回全文的 **`[skip, skip+length)` 纯文本切片**;切片恰好到文末(或全文不足)时**不加提示**,被截断时(精确判断 `skip+length < 全文长度`)尾部追加提示:`[内容已截断:全文约 N 字符,当前返回 a-b。可增大 length 或调 skip 续读剩余部分]`。
- **engine 映射**:`direct` → `X-Engine: curl`、`browser` → `X-Engine: browser`、`auto` → 不传;与 HTTP 层缓存键一致。
- **timeout 默认链**:`timeout` 参数 > env `READ_TIMEOUT` > 内建 90s;缓存命中不消耗预算。
- **一次一个 uri**,不支持并行(需要并行时由客户端自行开 subagent)。
- 本地文件上传解析支持 web(.html)、Word(.doc/.docx)、Excel(.xls/.xlsx)、PowerPoint(.ppt/.pptx)、PDF 及其他文档类文件;上传解析不缓存。
- 解析行为锚定:保留页面中**所有链接与图片 URL**(markdown 形式),**不递归嵌套解析**(不展开链接指向的页面)。

## HTTP API(server 直连)

server 容器把三件事合进一个端口:

| 能力 | 端点 | 说明 |
| --- | --- | --- |
| `read` | `GET /read/<url>`(别名 `/r/<url>`) | 网页/PDF → Markdown,进程内复用 jina 抓取 |
| `read` | `POST /read` | **文件上传解析**(multipart `file` → Markdown) |
| `search` | `GET /s/<query>`(`/search/ai/<query>`) | bocha AI 语义搜索(总结+参考源+模态卡+追问) |
| `search` | `GET /search/web/<query>` | bocha 网页搜索(长摘要列表) |
| `catalog` | `GET /catalog` | 工具目录:`{tools:[{name, description, annotations}]}`(desc/hints 单一来源,ADR-0009) |
| `mcp` | `POST /mcp` | MCP 服务(streamable HTTP),工具 `search`/`read` |
| `sse` | `GET /sse` + `POST /messages` | MCP legacy SSE 传输(兼容老客户端) |

### read(URL → Markdown)

`/read/**` 全量透传 jina 原生路由,`/r` 与 `/read` **完全同义**,支持**任意 method**。

| 路由 | method | 行为 |
| --- | --- | --- |
| `GET /read/<url>`(`/r/<url>`) | GET | 网页/PDF → Markdown 全文,接入缓存 |
| `GET /read`(无尾路径) | GET | 透传 jina 原生根路径(等价 jina `/`) |
| `POST /read`(无尾路径) | POST | **文件上传解析**(multipart `file` → Markdown),不缓存;见 [文件解析(上传)](#文件解析上传) |
| `/read/<url>` 其余方法 | 任意 | 透传 jina,不缓存 |

基本用法:

```bash
# 路径即 url;url 含 query string 时原样保留(不丢失)
curl "http://localhost:18081/r/https://example.com"
curl "http://localhost:18081/read/https://example.com?a=1&b=2"
```

要点:

- **路径即 url**:URL 需 URL 编码(如 `http://` 与 `/` 编码为 `%3A`、`%2F`),避免路径歧义;`?query` 部分照常追加在路径后,服务端改写转发时**保留原始 query string**(不丢失 `?foo=bar`)。
- **返回全文 Markdown**(`text/markdown`);分片续读是 MCP 工具能力,HTTP 层始终返回全文。
- **engine**:请求头 `X-Engine: browser`(浏览器渲染,适合动态页面)或 `X-Engine: curl`(轻量无 JS);缺省 `auto`(后端默认组合策略)。不同 engine 各自独立缓存。
- **timeout**:请求头 `X-Read-Timeout: <秒>` 控制本次请求整体超时(硬,超时 504);缺省走 env `READ_TIMEOUT`(默认 90s)。缓存命中瞬时返回,**不消耗**超时预算。详见 [缓存与超时](#缓存与超时)。
- **GET|POST 等价**:`POST /read/<url>` 与 GET 等价接入 read 缓存(jina 契约,ADR-0004),选项同样经 header(`X-Engine` / `X-Read-Timeout`);server 跳过该路径的 bodyParser,勿带 JSON body(会致 jina 内层 499)。
- **非 http(s) 资源**(本地文件等):服务端不直接抓取,请用 [文件解析(上传)](#文件解析上传) 的 `POST /read` 上传解析。

### search(bocha)

**GET**(路径即 query,支持 query string 高级参数):

```bash
# ai 语义搜索(快捷方式 /s,或 /search/ai)
curl "http://localhost:18081/s/今天天气如何?count=5"
curl "http://localhost:18081/search/ai/今天天气如何?count=5&freshness=oneDay"

# web 网页搜索
curl "http://localhost:18081/search/web/hello%20world?count=10&exclude=spam.com"
```

**POST**(标准 JSON body,GET/POST 交叉):

```bash
curl -X POST http://localhost:18081/search/ai \
  -H 'Content-Type: application/json' \
  -d '{"query":"今天天气如何","count":5,"freshness":"oneDay","include":"weather.com"}'
```

**高级参数**(web 与 ai 略有差异):

| 参数 | 说明 |
| --- | --- |
| `count` | 条数上限,默认 20,越界自动钳制到 1..50 |
| `freshness` | `noLimit`(默认)/`oneDay`/`oneWeek`/`oneMonth`/`oneYear` 或 `YYYY-MM-DD..YYYY-MM-DD`,非法值回退 `noLimit` |
| `include` | 限定站点,多个用 `\|` 或 `,` 分隔;web/ai 均支持 |
| `exclude` | 排除站点;仅 `web` 生效 |
| `summary` / `answer` | 是否返回长摘要 / AI 总结(布尔,默认透传官网) |

**响应**(结构化 JSON):

- `ai`:`{ "summary", "webPages": [...], "modalCards": [...], "followUpQuestions": [...] }`
- `web`:`{ "webPages": [...] }`(`webPages[]` 含 `name/url/siteName/snippet/summary`)

### health

```bash
curl http://localhost:18081/health
# {"service":"search-reader-mcp","status":"ok"}
```

`/` 与 `/health` 等价;`/read/**` 之外的路径均归本服务。

## 文件解析(上传)

非 http(s) 资源(本地文件/内网文件等)由服务端直接抓取不可行,改为**自行下载后上传解析**:以 multipart/form-data 上传文件,`POST /read` 即 jina 原生文件解析端点,字段名固定 `file`,支持 **PDF / Word / Excel / PPT / HTML / 纯文本**。(经 client 调用 `read` 时无需手动执行此步——client 读本地文件后自动完成。)

```bash
curl -X POST http://localhost:18081/read \
     -F 'file=@<本地文件路径>' \
     -H 'x-engine: auto' \
     -H 'x-retain-links: all' \
     -H 'x-retain-images: all'
```

> 提示:云部署时把 `http://localhost:18081` 换成服务端公网地址(`SERVER_URL` env,默认 `http://localhost:18081`)。

**参数解释**:

| 项 | 说明 |
| --- | --- |
| `-X POST` | 上传解析走 POST |
| `{SERVER_URL}/read` | 服务端上传解析端点;`{SERVER_URL}` 即服务端对外地址(默认 `http://localhost:18081`,云部署为公网地址) |
| `-F 'file=@<本地文件路径>'` | 以 multipart/form-data 上传文件,字段名固定 `file`;支持 PDF / Word / Excel / PPT / HTML / 纯文本 |
| `-H 'x-engine: auto'` | 解析引擎,对应 `read` 工具的 `engine` 参数:`auto`(默认,智能选择)/ `direct`(轻量无 JS)/ `browser`(浏览器渲染) |
| `-H 'x-retain-links: all'` | 保留页面中所有链接 URL(markdown 形式),默认全保留 |
| `-H 'x-retain-images: all'` | 保留页面中所有图片 URL(markdown 形式),默认全保留 |

**响应**:返回该资源的 Markdown 正文,所有链接与图片 URL 均以 markdown 保留;内容**不递归嵌套解析**(不展开链接指向的页面)。

可选 body 字段:

| 字段 | 说明 |
| --- | --- |
| `page` | PDF 选页 |
| `url` | raw HTML 的 base url |

上传解析**不缓存**(一次性语义,缓存键依赖文件内容,保持简单)。

## 缓存与超时

### read 缓存(一级)

只缓存**解析后的 Markdown 全文**(不缓存原始字节),HTTP 直连与 MCP `read` 工具共用同一缓存层。

| 项 | 行为 |
| --- | --- |
| 缓存键 | `uri(含 query)+ engine`;engine 归一化为 `auto`/`browser`/`curl` 三值 |
| TTL | `READ_CACHE_TTL`(默认 600s,10 分钟),命中后**滑动续期**(`expire_at = now + TTL`;写缓存基准 = 写入完成时刻) |
| 清理 | 惰性删除(访问到过期即删重抓)+ **每小时定时兜底清理**(仅删过期行) |
| in-flight 去重 | 同键并发只抓一次(共享进行中 Promise),完成后移除;不同 engine 互不等待 |
| 只缓存成功响应 | jina 非 200 / 超时不写缓存,避免缓存坏结果 |
| 缓存命中 | 瞬时返回,**不占用 timeout 预算** |
| 落盘 | 库文件同目录 `read-cache/`,文件名为 `sha256(键)`;索引存于 sqlite `read_cache` 表 |

### 超时(三层)

| 层 | 机制 | 语义 |
| --- | --- | --- |
| jina 内部抓取 | `x-timeout`(≤180s,透传) | 软:等网络空闲或到点,超时返回已有内容 |
| HTTP 层整体 | `X-Read-Timeout` header / env `READ_TIMEOUT`(默认 90s) | 硬:整体预算(加载 + 解析 + 返回),超时 **504** |
| MCP 参数 | `timeout`(≤600s) | 硬:超时返回可读错误文本 |

要点:

- **MCP `timeout` 语义 = 「加载 web + 解析」整体预算**(一次 http(s) 读取);默认解析链:`timeout` 参数 > env `READ_TIMEOUT` > 内建 90s。
- **透传映射**:整体预算 clamp 到 180 后同时作为 jina `x-timeout` 传入,让 jina 内部预算与整体对齐(不出现 jina 还挂着、我们先 504 的错位)。
- **HTTP 层**:`X-Read-Timeout` header 为 per-request 超时(MCP self-call 与 REST 通用);REST 调用方亦可用 `curl --max-time` 自控客户端等待。
- 超时 → **不写缓存**;缓存命中瞬时返回不消耗预算;timeout **不参与缓存键**。

## 开发

开发/构建/测试在**宿主**完成(代码改动走 git worktree 隔离,容器仅用于冒烟验证,见 [冒烟测试](./docs/smoke-test.md))。两项目各自独立依赖,分别在各自目录操作:

```bash
# server(容器项目)
cd server && npm install && npm test    # tsc + HTTP 契约测试 + 纯逻辑单测
# client(本地 stdio MCP 项目)
cd client && npm install && npm test    # tsc + MCP 协议接缝测试(主接缝)+ 纯逻辑单测
```

**测试**:

- **server**:`npm test` 覆盖 HTTP 契约(单一 seam,supertest 打 koa app,mock bocha 与 jina 桥接)与 MCP 纯逻辑(切片/截断提示/模板渲染/参数 schema/engine·timeout 映射)/catalog 契约与 hints 合规。`read/`、`mcp/`、`sse/` 依赖 jina 镜像运行时(Chrome 抓取、MCP 传输握手),需**容器内冒烟**验证(见 `docs/smoke-test.md`)。
- **client**:`npm test` 的**主接缝**是 MCP 协议边界——官方 `@modelcontextprotocol/sdk` 的 Client 经 stdio 连接真实 client,调用 `tools/list`/`tools/call` 断言结果;外部依赖(server HTTP、docker、本地文件)在注入点打桩,不触真实 server/容器。
- **冒烟**:`docs/smoke-test.md`(构建→启动→就绪→断言),以 **client 冒烟为主**(`node client/scripts/mcp-smoke.mjs` 经 stdio 连真实 client),server 直连冒烟(`server/scripts/mcp-smoke.mjs`)为补充。

## 目录结构

```
server/              自包含容器项目(即 Docker 构建 context)
  src/               TS 源码:index.ts 入口、server.ts 路由、config.ts、bocha/、mcp/、jina/、cache/、log/
  test/              HTTP 契约测试 + 纯逻辑单测(单一 seam)
  scripts/           mcp-smoke.mjs(server /mcp 直连冒烟)
  Dockerfile         基于 ghcr.io/jina-ai/reader:latest 扩展
  compose.yml        便捷启动(端口 18081、持久卷、MCP_* 描述 env)
client/              本地 stdio MCP 项目
  src/               index.ts(catalog/config/desc/docker/format/lifecycle/local-file/schema/server-http/slice/tools)
  test/              MCP 协议接缝测试(主接缝)+ 纯逻辑单测
  scripts/           mcp-smoke.mjs(client stdio 冒烟,以 client 为主)
docs/                术语(CONTEXT.md)、ADR、冒烟流程、roadmap
data/                运行时数据(本地开发)
```

## 参考

- [CONTEXT.md](./CONTEXT.md) — 领域术语表
- [docs/adr/](./docs/adr/) — 架构决策(单端口整合、search 独立、read 复用、全量路由挂载、缓存、非 http(s) 处理、报错即 prompt;v0.3:双产出物、catalog、本地文件边界、容器生命周期)
- [docs/roadmap.md](./docs/roadmap.md) — 演进路线
- [docs/smoke-test.md](./docs/smoke-test.md) — 冒烟流程(client 为主)
- [docs/agents/](./docs/agents/) — agent 技能文档(issue tracker / triage labels / domain)

## 认证
[![M8ven Score](https://m8ven.ai/badge/mcp/bob56621517-search-reader-mcp-4crvca)](https://m8ven.ai/mcp/bob56621517-search-reader-mcp-4crvca)
