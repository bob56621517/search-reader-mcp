# search-reader-mcp

扩展 [Jina Reader](https://jina.ai/reader) 镜像的项目:在 Jina Reader 基础上添加**自定义搜索(bocha)** 与 **MCP 服务**,以**单端口整合 HTTP 服务器**对外提供 `read` / `search` / `mcp` / `sse` 能力。

- **单服务、单端口**:一个进程承载全部能力(默认 18081),`docker-compose` 仅用于便捷启动
- **复用镜像环境**:进程内复用 jina 镜像的 Chrome 抓取、依赖与运行环境,不另起炉灶
- **MCP 双传输**:streamable HTTP 与 legacy SSE 兼容新旧客户端
- **read 增强**:Jina 全量路由挂载(含 `POST` 上传解析)、抓取结果缓存、MCP `read` 工具分片续读/引擎/超时控制

## 目录

- [介绍](#介绍)
- [快速开始](#快速开始)
- [配置(环境变量)](#配置环境变量)
- [API](#api)
  - [read(URL → Markdown)](#readurl--markdown)
  - [search(bocha)](#searchbocha)
  - [MCP(工具 `search`、`read`)](#mcp工具-searchread)
  - [health](#health)
- [文件解析(上传)](#文件解析上传)
- [缓存与超时](#缓存与超时)
- [开发](#开发)
- [参考](#参考)

## 介绍

本服务把三件事合进一个端口:

| 能力 | 端点 | 说明 |
| --- | --- | --- |
| `read` | `GET /read/<url>`(别名 `/r/<url>`) | 网页/PDF → Markdown,进程内复用 jina 抓取 |
| `read` | `POST /read` | **文件上传解析**(multipart `file` → Markdown) |
| `search` | `GET /s/<query>`(`/search/ai/<query>`) | bocha AI 语义搜索(总结+参考源+模态卡+追问) |
| `search` | `GET /search/web/<query>` | bocha 网页搜索(长摘要列表) |
| `mcp` | `POST /mcp` | MCP 服务(streamable HTTP),工具 `search`/`read` |
| `sse` | `GET /sse` + `POST /messages` | MCP legacy SSE 传输(兼容老客户端) |

对 **MCP 客户端**(Claude Code 等),本服务暴露 `search`(联网搜索)与 `read`(读取网页/PDF,支持分片续读)两个工具,详见 [MCP](#mcp工具-searchread)。

## 快速开始

### docker compose(推荐)

```bash
# 前提:宿主已有环境变量 BOCHA_API_KEY(搜索必需)
docker compose up -d --build
# 访问 http://localhost:18081
```

默认值集中在 `docker-compose.yml`,按需手工修改(端口、URL、路径等)。

### docker run

```bash
docker build -t search-reader-mcp .
docker run -d --name srm -p 18081:18081 -e BOCHA_API_KEY search-reader-mcp
```

启动后验证:

```bash
curl http://localhost:18081/health
# {"service":"search-reader-mcp","status":"ok"}
```

## 配置(环境变量)

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
| `READ_CACHE_TTL` | `300` | read 缓存 TTL(秒),命中后滑动续期;见 [缓存与超时](#缓存与超时) |
| `READ_TIMEOUT` | `90` | HTTP 层整体超时兜底(秒),超时 504;见 [缓存与超时](#缓存与超时) |
| `SERVER_URL` | `http://localhost:18081` | 服务端对外地址,用于上传解析提示词模板渲染;云部署改为公网地址 |
| `MCP_*` | 内建描述 | MCP 工具/参数描述 env 覆盖,见下 |

**持久化**:sqlite 库、缓存文件(`<dataDir>/read-cache/`)与 `.log/` 日志外挂宿主 `~/.search_reader_mcp/`,容器重建后数据仍在。

### MCP 描述 env 化(`MCP_*`)

工具与参数描述可经环境变量覆盖,缺省为内建描述。模式:`MCP_<TOOL>_DESC` = 工具描述,`MCP_<TOOL>_<PARAM>` = 参数描述;env 有值即覆盖,未设置沿用内建。

| env | 对应 |
| --- | --- |
| `MCP_SEARCH_DESC` | `search` 工具描述 |
| `MCP_SEARCH_TYPE` / `MCP_SEARCH_QUERY` / `MCP_SEARCH_COUNT` / `MCP_SEARCH_FRESHNESS` / `MCP_SEARCH_INCLUDE`(单数)/ `MCP_SEARCH_EXCLUDE` | `search` 各参数 |
| `MCP_READ_DESC` | `read` 工具描述 |
| `MCP_READ_URI` / `MCP_READ_SKIP` / `MCP_READ_LENGTH` / `MCP_READ_ENGINE` / `MCP_READ_TIMEOUT` | `read` 各参数 |

## API

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
- **非 http(s) 资源**(本地文件等):服务端不直接抓取,请用 [文件解析(上传)](#文件解析上传) 的 `POST /read` 上传解析;MCP `read` 工具遇到非 http(s) uri 会返回可执行的上传引导模板。

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

### MCP(工具 `search`、`read`)

- **streamable HTTP**:`POST /mcp`(协议:JSON-RPC + SSE 流,服务端生成 `Mcp-Session-Id`)
- **legacy SSE**:`GET /sse` 建流,`POST /messages` 发请求

**Claude Code 接入示例**(`~/.claude.json` 或项目 `.mcp.json`):

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

**工具**:

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `search` | `type`(默认 `ai`,可 `web`)、`query`、`count`、`freshness`、`include`、`exclude` | 格式化文本:AI 总结/模态卡/编号网页来源/追问 |
| `read` | `uri`、`skip`、`length`、`engine`、`timeout` | 网页/PDF → Markdown 切片,支持分片续读 |

**`read` 工具参数**:

| 参数 | 类型 | 默认 | 校验 |
| --- | --- | --- | --- |
| `uri` | string | 必填 | http(s) 资源由服务端抓取;其他 scheme 返回上传引导模板 |
| `skip` | int | `0` | 非负;跳过开头字符数,用于分片续读 |
| `length` | int | `5000` | `1..50000`;返回切片长度,越界 schema 拒绝 |
| `engine` | enum | `auto` | `auto`/`direct`/`browser`(暂不含 `cf-browser-rendering`) |
| `timeout` | int(秒) | 见下 | 正整数,≤600 |

`read` 行为要点:

- 返回全文的 **`[skip, skip+length)` 纯文本切片**;切片恰好到文末(或全文不足)时**不加提示**,被截断时(精确判断 `skip+length < 全文长度`)尾部追加提示:`[内容已截断:全文约 N 字符,当前返回 a-b。可增大 length 或调 skip 续读剩余部分]`。
- **engine 映射**:`direct` → `X-Engine: curl`、`browser` → `X-Engine: browser`、`auto` → 不传;与 HTTP 层缓存键一致。
- **timeout 默认链**:`timeout` 参数 > env `READ_TIMEOUT` > 内建 90s;缓存命中不消耗预算。
- **一次一个 uri**,不支持并行(需要并行时由客户端自行开 subagent)。
- **非 http(s) uri**(`file:`/`ftp:`/`s3:`/`data:` 等)返回自包含上传引导模板(含可执行 curl 示例),不尝试抓取;模板权威依据见 [文件解析(上传)](#文件解析上传)。
- 解析行为锚定:保留页面中**所有链接与图片 URL**(markdown 形式),**不递归嵌套解析**(不展开链接指向的页面)。

### health

```bash
curl http://localhost:18081/health
# {"service":"search-reader-mcp","status":"ok"}
```

`/` 与 `/health` 等价;`/read/**` 之外的路径均归本服务。

## 文件解析(上传)

非 http(s) 资源(本地文件/内网文件等)由服务端直接抓取不可行,改为**自行下载后上传解析**:以 multipart/form-data 上传文件,`POST /read` 即 jina 原生文件解析端点,字段名固定 `file`,支持 **PDF / Word / Excel / PPT / HTML / 纯文本**。

```bash
curl -X POST http://localhost:18081/read \
     -F 'file=@<本地文件路径>' \
     -H 'x-engine: auto' \
     -H 'x-retain-links: all' \
     -H 'x-retain-images: all'
```

> 提示:云部署时把 `http://localhost:18081` 换成服务端公网地址(`SERVER_URL` env,默认 `http://localhost:18081`)。

**参数解释**(与服务端 `read` 工具功能对齐):

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
| TTL | `READ_CACHE_TTL`(默认 300s),命中后**滑动续期**(`expire_at = now + TTL`) |
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

开发环境**直接使用 jina 镜像**(复用 Node 24 + Chrome + 依赖)。

```bash
# 开发容器:挂载工作区 + tsc --watch + node --watch 热重载(端口 18082 映射到容器 18081)
docker compose up dev

# 或手动:宿主构建 + 单测,容器内验证
npm install                 # 宿主开发/测试依赖(koa/supertest 等已在 devDependencies)
npm test                    # tsc + HTTP 契约测试 + 纯逻辑单测
npm run build               # 构建到 dist/
```

**测试**:`npm test` 覆盖 HTTP 契约(单一 seam,supertest 打 koa app,mock bocha 与 jina 桥接)与 MCP `read` 纯逻辑(切片/截断提示/模板渲染/参数 schema/engine·timeout 映射)。`read/`、`mcp/`、`sse/` 依赖 jina 镜像运行时(Chrome 抓取、MCP 传输握手),需**容器内冒烟**验证:`docs/smoke-test.md`(构建→启动→就绪→各端点断言),MCP 工具验证 `scripts/mcp-smoke.mjs`。

## 目录结构

```
src/
  index.ts         入口(加载配置 → jina 桥接 → 服务器 → 监听)
  server.ts        整合服务器(路由分发 + read 全量挂载/缓存/timeout + 请求·错误日志)
  config.ts        环境变量配置(含 mcpDesc 描述 env 化)
  bocha/           bocha 能力层(客户端 + VO 类型)
  mcp/             MCP 服务层(server.ts 工具、read-tools.ts 纯逻辑:切片/模板/schema)
  jina/            jina koaApp 桥接(复用抓取)
  cache/           sqlite 缓存基础设施(read_cache 表 + 读写/续期/清理 + in-flight 去重)
  log/             按天滚动文件日志
test/              HTTP 契约测试 + 纯逻辑单测(单一 seam)
docs/              术语(CONTEXT.md)、ADR、冒烟流程
scripts/           冒烟辅助脚本
```

## 参考

- [CONTEXT.md](./CONTEXT.md) — 领域术语表
- [docs/adr/](./docs/adr/) — 架构决策(单端口整合、search 独立、read 复用、全量路由挂载、缓存、非 http(s) 处理、报错即 prompt)
- [docs/roadmap.md](./docs/roadmap.md) — 演进路线
- [docs/smoke-test.md](./docs/smoke-test.md) — 容器冒烟流程
- [docs/agents/](./docs/agents/) — agent 技能文档(issue tracker / triage labels / domain)

## 认证
[![M8ven Score](https://m8ven.ai/badge/mcp/bob56621517-search-reader-mcp-4crvca)](https://m8ven.ai/mcp/bob56621517-search-reader-mcp-4crvca)
