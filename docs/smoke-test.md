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
docker build -t search-reader-mcp .
```

### 2. 启动容器(带短 TTL,便于缓存验证)

```bash
docker rm -f srm 2>/dev/null
docker run -d --name srm -p 18081:18081 \
  -e BOCHA_API_KEY -e PORT=18081 \
  -e READ_CACHE_TTL=5 -e READ_TIMEOUT=90 -e SERVER_URL=http://localhost:18081 \
  search-reader-mcp
```

`READ_CACHE_TTL=5`(秒)让缓存秒级过期,便于 4.3 验证命中/续期/失效重抓;生产默认 300 见 `docker-compose.yml`。

### 3. 等待就绪

Chrome 初始化需数秒(本机约 9s)。轮询 health:

```bash
for i in $(seq 1 20); do sleep 3; code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18081/health 2>/dev/null); [ "$code" = "200" ] && break; done; echo "health=$code"
```

### 4. HTTP 冒烟

#### 4.1 read:`GET /read/<url>`(路径即 url)+ query 保留

```bash
# 路径即 url,无需 query 参数;附加 query string 验证保留(改写的 req.url 不丢参数)
curl -s -o /tmp/read1.md -w 'code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/?utm_source=smoke&x=1'
```

断言:

- `code=200`,`/tmp/read1.md` 为 Markdown 正文(含 example.com 标题文本)
- query 保留:带 query string 的 URL 正常抓取返回。容器内不直接观测 jina 收到的 `req.url`;**query 保留的强断言在宿主单测**(`test/read.http.test.js` 断言改写后 `req.url === '/http://example.com?a=1&b=2'`);容器冒烟确认真实 jina 下带 query 的 URL 不报错即可

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

> 上传解析**不缓存**(一次性语义):重复上传同一文件,每次均为 200(可复核 `docker logs srm`,每次都是上传请求而非缓存命中)。

#### 4.3 read 缓存:命中 / 滑动续期 / 失效重抓

利用 `READ_CACHE_TTL=5`。取同一 URL(缓存键 = uri 含 query + engine 归一化;此处不带 query 保持干净):

```bash
# 第一次:miss,走 jina 抓取(记录基准耗时)
curl -s -o /tmp/c1.md -w 'c1 code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/'
# 立即第二次:hit,缓存瞬时返回
curl -s -o /tmp/c2.md -w 'c2 code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/'
diff /tmp/c1.md /tmp/c2.md && echo 'body 一致'
```

断言:

- `c2.time_total` 显著小于 `c1`(命中瞬时返回,不占 timeout 预算);两次 body 一致(`diff` 无输出)
- 佐证:`docker logs srm | tail`,`GET /r/https://example.com/` 第二次耗时 ms 级(第一次为抓取量级)

**滑动续期**(TTL=5 窗口内连续访问,每次命中并续期,全程不重抓):

```bash
# t≈0 抓取 → t≈2s 命中(续期到 7s)→ t≈4s 命中(续期到 9s)→ t≈6s 命中(未续期则 5s 已过期)
for i in 1 2 3 4; do curl -s -o /dev/null -w "h$i time=%{time_total}s\n" \
  'http://localhost:18081/read/https://example.com/'; sleep 2; done
```

断言:四次均命中(耗时都小);`docker logs srm` 中该 URL 仅第一次出现抓取耗时,其余为 ms 级 → 每次访问都在滑动续期,未因 TTL 过期重抓。

**失效重抓**(等 TTL 过期后再请求,重新抓取):

```bash
sleep 6   # > READ_CACHE_TTL=5,缓存已过期
curl -s -o /tmp/c3.md -w 'c3 code=%{http_code} time=%{time_total}s\n' \
  'http://localhost:18081/read/https://example.com/'
diff /tmp/c1.md /tmp/c3.md && echo 'body 一致'
```

断言:`c3.time_total` 恢复抓取量级(≈c1),body 仍一致 → 惰性删除 + 失效重抓。

> 缓存行为的硬断言(同键命中不重复调用、engine 键隔离、非 200 不写缓存、超时不写缓存)在宿主单测 `test/cache.test.js`/`test/read.http.test.js`;容器冒烟验证真实 jina 下的时间行为与 body 一致性。

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
| `POST /mcp`(initialize, JSON-RPC) | `serverInfo: search-reader-mcp`;**响应带 `Mcp-Session-Id`** |
| `GET /sse` | `event: endpoint` + `data: /messages?sessionId=...` |

### 5. MCP 工具调用(`scripts/mcp-smoke.mjs`)

```bash
node scripts/mcp-smoke.mjs            # 默认 http://localhost:18081
node scripts/mcp-smoke.mjs http://host:port
```

脚本初始化 streamable HTTP 会话后逐项断言,打印 `[PASS]`/`[FAIL]`;**任一项失败以 exit 1 退出**,可直接用于 CI 门禁。检查点:

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

确认 `/read/**` 全量覆盖 + `POST /read` 上传解析真实存在:

```bash
docker exec srm node -e "
const app = require('/app/build/stand-alone/crawl.js').default.koaApp;
const router = app.router || app._router;
if (!router) { console.log('未找到 router,koaApp 字段:', Object.keys(app)); process.exit(1); }
router.stack.forEach((l) => console.log(((l.methods && l.methods.join(',')) || '*'), l.path));
"
```

断言:

- 输出为 jina 原生路由清单(实际以镜像版本为准,通常含 `GET /`、`/pdf`、`/screenshot` 等)
- 结合 4.1/4.2 实测:`/read/**`(任意 method 透传)下 `GET /read/<url>` 与 `POST /read` 上传解析均 200,证明全量挂载面已覆盖

> 若镜像升级后 `koaApp.router` 字段名变化,改用 `Object.keys(app)` 定位后重试;路由清单仅用于确认挂载面,挂载映射的强断言在宿主单测 `test/read.http.test.js`。

### 7. 清理

```bash
docker rm -f srm
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
- **MCP 无 `Mcp-Session-Id`**:确认 transport 使用 `sessionIdGenerator`(非 `undefined`,否则是无状态模式)。
- **`MCP read 工具报错 / 参数名不符`**:v7 起 read 工具参数为 `uri`(旧 `url` 已废弃);请用最新 `scripts/mcp-smoke.mjs`,勿用旧版 `url` 参数。
- **缓存时间抖动**:本机网络慢时第一次抓取可能 >5s,导致 TTL 提前过期、4.3 的「命中」断言失败;此时把 `READ_CACHE_TTL` 调大(如 15)重跑,并相应调整 `sleep`。
- **上传返回错误页而非 Markdown**:确认上传文件真实可解析(HTML 有完整 `<html>` 结构、PDF 非损坏);jina 对无法解析的文件返回错误页,属预期。
- **容器内抓取外部站点超时/失败**:确认容器出网正常(`docker exec srm node -e "fetch('https://example.com').then(r=>console.log(r.status))"`);代理/防火墙环境下 example.com 可能被拦,可换可达的 http(s) 页面。
