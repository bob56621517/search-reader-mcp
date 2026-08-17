# 冒烟测试流程

宿主单测 `npm test` 覆盖 HTTP 契约(search/read 路由、query 保留、缓存行为、参数钳制)与 read 纯逻辑(切片/截断/模板/engine 映射),但以下行为依赖 jina 镜像运行时(Chrome 抓取、原生上传解析、MCP 传输握手),需在**容器内冒烟**验证:

- `GET /read/<url>` 的真实 jina 抓取与 query string 保留
- `POST /read` 上传解析(PDF/HTML)及对 `x-engine`/`x-retain-links`/`x-retain-images` header 的实际支持
- read 缓存命中 / 滑动续期 / 失效重抓(真实 jina 下的时间行为)
- MCP streamable HTTP 握手与 `read`/`search` 工具经真实传输的端到端调用
- docker exec 列出 jina koaApp 实际路由清单,确认 `/read/**` 全量覆盖

以下按本次实测流程记录。

## 前置

- Docker daemon 运行;宿主环境变量 `BOCHA_API_KEY` 已有值(容器透传,search 必需)
- 宿主端口 18081 空闲
- 宿主已有 `curl`(Git Bash 自带);`node` ≥ 18(跑 MCP 冒烟脚本)

## 流程

### 1. 构建镜像

```bash
docker compose build search-reader-mcp
```

### 2. 启动容器(compose,持久化卷挂载)

```bash
docker compose up -d --build search-reader-mcp
```

compose 默认配置(见 `docker-compose.yml`):端口 18081;`READ_CACHE_TTL=300`(秒,生产默认);数据卷挂载宿主 `~/.search_reader_mcp` → 容器 `/app/extension/data`(sqlite 缓存库 `cache.db`、`read-cache/`、`.log/` 日志均落宿主,便于 4.3 直接查库验证)。

> 若要验证缓存**失效重抓**(需要秒级过期),可用临时短 TTL 容器(不挂卷,避免污染持久缓存):`docker run -d --name srm -p 18081:18081 -e BOCHA_API_KEY -e READ_CACHE_TTL=5 -e READ_TIMEOUT=90 -e SERVER_URL=http://localhost:18081 search-reader-mcp`,验证完 `docker rm -f srm`。4.3 默认走 compose 的 TTL=300 验证命中/续期。

### 3. 等待就绪

Chrome 启动**不稳定且较慢**:容器常遇 jina 内部 puppeteer 10s 超时(`Timed out after 10000 ms while waiting for the WS endpoint URL`),进程退出后由 `restart: unless-stopped` 拉起,通常 1-2 次后能起来。**给足 30-60s**,轮询 health:

```bash
for i in $(seq 1 30); do sleep 3; code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18081/health 2>/dev/null); [ "$code" = "200" ] && break; done; echo "health=$code"
```

若多轮仍未 200,`docker logs search-reader-mcp | tail` 看 Chrome 超时/重启循环,稍等重试即可(不要反复 `up -d`,会加重重启竞争)。

### 4. HTTP 冒烟

#### 4.1 read:`GET /read/<url>`(路径即 url)+ query 保留

```bash
# 路径即 url,无需 query 参数;附加 query string 验证保留(改写的 req.url 不丢参数)
# 注意用普通参数(如 ?x=1)而非 utm 类:jina 会清理 utm_source 等追踪参数(见下)
curl -s -o /tmp/read1.md -w 'code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/?x=1'
```

断言:

- `code=200`,`/tmp/read1.md` 为 Markdown 正文(含 example.com 标题文本)
- query 保留:带 query string 的 URL 正常抓取返回。容器内不直接观测 jina 收到的 `req.url`;**query 保留的强断言在宿主单测**(`test/read.http.test.js` 断言改写后 `req.url === '/http://example.com?a=1&b=2'`);容器冒烟确认真实 jina 下带 query 的 URL 不报错即可
- **UTM 清理(实测)**:jina 会清掉 `utm_source` 等追踪参数——URL Source 显示 `?x=1` 而非 `?utm_source=smoke&x=1`。故容器侧断言 query 保留请用非 utm 普通参数(如 `?x=1`);带 utm 的 URL 仍正常抓取,只是 query 被 jina 清洗,属镜像原生行为,非我们丢参(我们改写 `req.url` 保留原始 query,见宿主单测)

`/r/` 与 `/read/` 完全同义,任选其一验证。

#### 4.2 read:`POST /read` 上传解析(PDF/HTML)+ header 支持

准备上传样本:`test/fixtures/links.html`(仓库内,含 1 个链接 + 1 个图片,见「测试文件」)。

```bash
# HTML 上传:显式传 x-engine / x-retain-links / x-retain-images,验证 header 实际支持
curl -s -o /tmp/upload-html.md -w 'code=%{http_code}\n' \
  -X POST http://localhost:18081/read \
  -F 'file=@test/fixtures/links.html' \
  -H 'x-engine: auto' -H 'x-retain-links: all' -H 'x-retain-images: all'
```

断言:

- `code=200`,`/tmp/upload-html.md` 为 Markdown 正文(含「冒烟上传样本」标题)
- **header 实际支持**:输出中保留链接 URL `https://example.com/` 与图片 URL `https://example.com/smoke-image.png`(markdown 语法)→ 证明 `x-retain-links`/`x-retain-images: all` 对上传解析生效(宿主单测无法验证,属实现期实测项 spec「十二」)

换 `x-engine`(如 `browser`/`direct`)重复上传:引擎只影响抓取方式,不影响链接/图片保留,断言仍含两个 URL。

PDF 上传:

```bash
# 任选一个真实可解析的 PDF(如宿主 ~/Downloads/sample.pdf),同样命令
curl -s -o /tmp/upload-pdf.md -w 'code=%{http_code}\n' \
  -X POST http://localhost:18081/read \
  -F 'file=@<本地 PDF 路径>' \
  -H 'x-engine: auto' -H 'x-retain-links: all' -H 'x-retain-images: all'
```

断言:`code=200`,输出含 PDF 内文本(如标题/正文关键词)。若暂无可解析 PDF,HTML 上传已覆盖上传管线,PDF 解析为 jina 原生能力可跳过并注明。

> 上传解析**不缓存**(一次性语义):重复上传同一文件,每次均为 200(可复核 `docker logs search-reader-mcp`,每次都是上传请求而非缓存命中)。

#### 4.3 read 缓存:命中 / 滑动续期 / query 作键(compose TTL=300)

缓存键 = `uri(含 query) + engine` 归一化;命中即滑动续期(`expire_at = now + TTL`),过期惰性删除重抓。compose 默认 `READ_CACHE_TTL=300`,**命中与续期**用宿主侧 sqlite 直接查 `expire_at` 验证(库在 `~/.search_reader_mcp/cache.db`,表 `read_cache`;查库需 node ≥ 22.5,宿主 `node -p process.version` 确认):

```bash
# 记录某个 URL 当前缓存条目的 expire_at(epoch ms)
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.HOME+'/.search_reader_mcp/cache.db');console.table(d.prepare('SELECT uri,engine,expire_at FROM read_cache').all())"

# 命中:再次 GET,应瞬时返回(首次抓取为 3-15s 量级)
curl -s -o /tmp/c2.md -w 'hit code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/?x=1'
```

断言:

- 命中耗时 **ms 级**(首次抓取为秒级);再查库,该行 `expire_at` 已被**滑动续期**为更大的 `now+300s`
- **query 作缓存键**:同一 URL 加不同 query(`?x=1`)是独立缓存条目——首次 miss(秒级)、二次 hit(ms 级);`read_cache` 表可见 `uri` 带 `?x=1` 的独立行
- **UTM 与键隔离**:`?utm_source=` 虽被 jina 清洗,但仍是独立缓存键(我们按原始 query 建键),与 4.1 的 UTM 清理互不影响

**失效重抓**:TTL=300 下等过期不现实,**由宿主单测覆盖**(`test/cache.test.js`「缓存过期后重新加载」)。若确需容器实测,用第 2 节所述短 TTL 临时容器,或直接删缓存文件 `rm ~/.search_reader_mcp/read-cache/<sha256>.md`(等价触发惰性删除)后重抓。

> 缓存行为的硬断言(同键命中不重复调用、engine 键隔离、非 200 不写缓存、超时不写缓存)在宿主单测 `test/cache.test.js`/`test/read.http.test.js`;容器冒烟验证真实 jina 下的时间行为、`expire_at` 续期与 query 键隔离。

#### 4.4 search 端点(保持)

| 端点 | 断言 |
| --- | --- |
| `GET /s/<中文query>?count=2` | 200;`summary` 非空 + `webPages[]` 数组 |
| `GET /search/web/<query>?count=2` | 200;`webPages[]`(标题/链接/站点/摘要) |

中文 query 注意 URL 编码:浏览器会自动编码;curl 需手动 `encodeURIComponent`。

#### 4.5 health / MCP 传输握手

| 端点 | 断言 |
| --- | --- |
| `GET /` 与 `GET /health` | 200;`{"service":"search-reader-mcp","status":"ok"}` |
| `POST /mcp`(initialize, JSON-RPC) | `serverInfo: search-reader-mcp`;**无状态模式:不返回 `Mcp-Session-Id`**,每次请求独立、天然支持多客户端 |
| `GET /sse` | legacy SSE(连接级会话):`event: endpoint` + `data: /messages?sessionId=...`;每连接独立 transport,按连接隔离 |

### 5. MCP 工具调用(`scripts/mcp-smoke.mjs`)

```bash
node scripts/mcp-smoke.mjs            # 默认 http://localhost:18081
node scripts/mcp-smoke.mjs http://host:port
```

脚本对 `/mcp`(streamable HTTP,**无状态模式**:不返回/不携带 `Mcp-Session-Id`,每次请求独立,天然支持多客户端)做初始化握手与逐项工具断言,打印 `[PASS]`/`[FAIL]`;**任一项失败以 exit 1 退出**,可直接用于 CI 门禁。检查点:

- `tools/list` 返回 `search`/`read`
- `read` 工具(参数为 v7 的 `uri`):
  - `read(uri)` 抓取目标页返回 Markdown(URL Source 干净,无 `?url=` 污染)
  - 切片 + **截断提示**:`length` 小于全文时尾部含 `[内容已截断:全文约 N 字符...]`
  - 完整返回(大 `length`)无截断提示
  - **非 http(s)**(如 `file:///tmp/x`)返回上传引导模板(含 `curl -X POST .../read`、`x-retain-links: all`,且无 `{SERVER_URL}` 占位符残留)
  - `engine`/`timeout` 参数透传可用(`engine=browser`/`direct`、`timeout=30` 均正常返回)
- `search` 工具(行为锚定):
  - `type='web'` → 编号网页列表(`1. 标题(url) [站点]`)
  - 默认 `type`(ai)→ AI 总结/编号来源/追问(行为锚定,与 web 形态不同)
  - `count` 钳制:`count=999` 正常返回不报错
  - `freshness` 非法值:`freshness='garbage'` 回退 `noLimit`,正常返回

### 6. docker exec 列 jina koaApp 实际路由清单

确认 `/read/**` 全量覆盖 + `POST /read` 上传解析真实存在。**jina 不用 koa-router**(koaApp 无 `router`/`_router` 字段、无 `router.stack`);路由是 `registerRoutes()` 挂的**中间件链**,`middleware` 在 `serviceReady()` 后才填充。注意 `require(crawl.js)` 会触发完整服务初始化(副作用:临时多启一套 worker/Chrome,探测完 `process.exit(0)` 退出):

```bash
docker exec search-reader-mcp node -e '
const m = require("/app/build/stand-alone/crawl.js").default;
(async () => { await m.serviceReady(); const app = m.koaApp;
  console.log("middleware count:", app.middleware.length);
  app.middleware.forEach((mw, i) => console.log(i, mw.name || "(anon)", "| router:", !!mw.router));
  process.exit(0);
})();'
```

实测(镜像 ghcr.io/jina-ai/reader:latest)输出 `middleware count: 7`,清单:

| # | 中间件 | 角色 |
| --- | --- | --- |
| 0 | `asyncHookMiddleware` | 请求 traceId 注入 |
| 1 | `healthCheck` | health 探针 |
| 2 | `loggingMiddleware` | 请求日志 |
| 3 | (anon) | CORS/公共中间件 |
| 4 | `compressMiddleware` | 响应压缩 |
| 5 | (anon) | `makeAssetsServingController()`(静态资产) |
| 6 | (anon) | `registry.makeShimController()`(**核心路由分发**,把 path 当目标 URL) |

路由来源(grep 编译产物可复核):`docker exec search-reader-mcp grep -n "koaApp.use" /app/build/stand-alone/crawl.js` → `compressMiddleware`、`makeAssetsServingController()`、`registry.makeShimController()`、`asyncHookMiddleware`。

断言:

- 输出含 7 个中间件(以镜像版本为准);核心分发是 #6 shimController,它把 `ctx.path`(形如 `/http://example.com`)当目标 URL 交给抓取栈 → 印证 `/read/<url>` 透传语义
- 结合 4.1/4.2 实测:`/read/**`(任意 method 透传)下 `GET /read/<url>` 与 `POST /read` 上传解析均 200,证明全量挂载面已覆盖

> 挂载映射的强断言在宿主单测 `test/read.http.test.js`;容器侧仅确认中间件链与真实抓取 200。镜像升级后若清单变化,以 `middleware count` 与 grep `koaApp.use` 复核为准。

### 7. 清理

```bash
docker compose down          # 停止并移除 compose 容器
# 持久数据保留在宿主 ~/.search_reader_mcp/(cache.db、read-cache/、.log/),不随容器删除
# 若用了第 2 节短 TTL 临时容器:`docker rm -f srm`
```

## 测试文件

`test/fixtures/links.html`(仓库内,冒烟上传样本,含链接与图片):

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>smoke-fixture</title></head>
<body><h1>冒烟上传样本</h1>
<a href="https://example.com/">示例链接 example.com</a>
<img src="https://example.com/smoke-image.png" alt="冒烟图片">
<p>正文结尾。</p></body></html>
```

上传断言:输出含 `https://example.com/`(链接)与 `https://example.com/smoke-image.png`(图片)的 markdown 形式 → 验证 `x-retain-links`/`x-retain-images: all` 实际支持。

## 常见问题

- **容器秒退 / `Cannot find module '/app/sleep'`**:镜像 `ENTRYPOINT` 是 `node`;跑临时容器需 `--entrypoint /bin/sleep`(且注意 Git Bash 的路径转换,加 `MSYS_NO_PATHCONV=1`)。
- **`/sse` 无响应**:确认 `SSEServerTransport` 显式 `await tx.start()`(McpServer.connect 不会自动调)。
- **MCP 无 `Mcp-Session-Id`(预期行为)**:`/mcp` 走**无状态模式**,初始化不返回 `Mcp-Session-Id`,每次请求独立、支持多客户端;脚本 `mcp-smoke.mjs` 已适配,勿再断言 session id。若曾出现第二个客户端报 `Server already initialized`,那是旧版有状态单例 transport 的缺陷,已改为无状态修复。
- **`MCP read 工具报错 / 参数名不符`**:v7 起 read 工具参数为 `uri`(旧 `url` 已废弃);请用最新 `scripts/mcp-smoke.mjs`,勿用旧版 `url` 参数。
- **缓存时间抖动**:compose 默认 TTL=300,正常抓取(秒级)远小于 TTL,不会抖动;仅短 TTL 临时容器(如 5s)在网络慢时可能提前过期,此时调大 `READ_CACHE_TTL` 重跑。
- **Chrome 启动超时 / 容器重启循环**:见第 3 节——puppeteer 10s 超时导致进程退出后由 `restart: unless-stopped` 拉起,属镜像原生现象,等 30-60s 后 health 200 即正常;不要反复 `docker compose up -d` 加重重启竞争。
- **上传返回错误页而非 Markdown**:确认上传文件真实可解析(HTML 有完整 `<html>` 结构、PDF 非损坏);jina 对无法解析的文件返回错误页,属预期。
- **容器内抓取外部站点超时/失败**:确认容器出网正常(`docker exec search-reader-mcp node -e "fetch('https://example.com').then(r=>console.log(r.status))"`);代理/防火墙环境下 example.com 可能被拦,可换可达的 http(s) 页面。
