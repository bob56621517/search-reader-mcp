# search-reader-mcp

扩展 [Jina Reader](https://jina.ai/reader) 镜像的项目:在 Jina Reader 基础上添加**自定义搜索(bocha)**与 **MCP 服务**,以**单端口整合 HTTP 服务器**对外提供 `read` / `search` / `mcp` / `sse` 能力。

- **单服务、单端口**:一个进程承载全部能力(默认 18081),`docker-compose` 仅用于便捷启动
- **复用镜像环境**:进程内复用 jina 镜像的 Chrome 抓取、依赖与运行环境,不另起炉灶
- **MCP 双传输**:streamable HTTP 与 legacy SSE 兼容新旧客户端

## 特性

| 能力 | 端点 | 说明 |
| --- | --- | --- |
| `read` | `GET /read/<url>`(`/r/<url>`) | 网页/PDF → Markdown,进程内复用 jina 抓取 |
| `search` | `GET /s/<query>`(`/search/ai/<query>`) | bocha AI 语义搜索(总结+参考源+模态卡+追问) |
| `search` | `GET /search/web/<query>` | bocha 网页搜索(长摘要列表) |
| `mcp` | `POST /mcp` | MCP 服务(streamable HTTP),工具 `search`/`read` |
| `sse` | `GET /sse` + `POST /messages` | MCP legacy SSE 传输(兼容老客户端) |

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

## 配置(环境变量)

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `18081` | 监听端口(容器内外一致) |
| `HOST` | `0.0.0.0` | 监听地址 |
| `BOCHA_API_KEY` | — | **必填**(搜索);开发/compose 共用标准环境变量 |
| `BOCHA_URL` | `https://api.bochaai.com` | bocha API base-url |
| `JINA_APP` | `/app` | jina 镜像应用根目录 |
| `SEARCH_READER_MCP_DATA` | `/app/extension/data` | 持久化数据目录(compose 外挂宿主 `~/.search_reader_mcp/`) |
| `SQLITE_PATH` | `<dataDir>/cache.db` | sqlite 缓存库路径 |
| `LOG_DIR` | `<dataDir>/.log` | 日志目录(按天滚动) |

**持久化**:sqlite 库与 `.log/` 日志外挂宿主 `~/.search_reader_mcp/`,容器重建后数据仍在。

## API

### read(URL → Markdown)

```bash
curl "http://localhost:18081/r/https://example.com"
# 或 /read/<url>
```

返回目标页面的 Markdown 正文(文本/plain)。

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

工具说明:

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `search` | `type`(默认 `ai`,可 `web`)、`query`、`count`、`freshness`、`include`、`exclude` | 格式化文本:AI 总结/模态卡/编号网页来源/追问 |
| `read` | `url` | 网页/PDF → Markdown 正文 |

### health

```bash
curl http://localhost:18081/health
# {"service":"search-reader-mcp","status":"ok"}
```

## 开发

开发环境**直接使用 jina 镜像**(复用 Node 24 + Chrome + 依赖)。

```bash
# 开发容器:挂载工作区 + tsc --watch + node --watch 热重载(端口 18082 映射到容器 18081)
docker compose up dev

# 或手动:宿主构建 + 单测,容器内验证
npm install --no-save koa @koa/bodyparser supertest @types/supertest   # 宿主开发依赖
npm test                    # tsc + 16 个 HTTP 契约测试
npm run build               # 构建到 dist/
```

**容器冒烟**:`docs/smoke-test.md`(构建→启动→就绪→各端点断言),MCP 工具验证 `scripts/mcp-smoke.mjs`。

## 目录结构

```
src/
  index.ts         入口(加载配置 → jina 桥接 → 服务器 → 监听)
  server.ts        整合服务器(路由分发 + 请求/错误日志)
  config.ts        环境变量配置
  bocha/           bocha 能力层(客户端 + VO 类型)
  mcp/             MCP 服务层(search/read 工具)
  jina/            jina koaApp 桥接(复用抓取)
  cache/           sqlite 缓存基础设施(先建库)
  log/             按天滚动文件日志
test/              HTTP 契约测试(单一 seam)
docs/              术语(CONTEXT.md)、ADR、冒烟流程
scripts/           冒烟辅助脚本
```

## 参考

- [CONTEXT.md](./CONTEXT.md) — 领域术语表
- [docs/adr/](./docs/adr/) — 架构决策(单端口整合、search 独立、read 复用)
- [docs/smoke-test.md](./docs/smoke-test.md) — 容器冒烟流程
