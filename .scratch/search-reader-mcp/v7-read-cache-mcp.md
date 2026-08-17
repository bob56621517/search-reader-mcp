# search-reader-mcp 一期增强 v7 定稿

**日期**:2026-08-17
**状态**:定稿(ready-for-agent)
**仓库**:`C:\Users\shixy\gitWorkspace\search-reader-mcp`(branch `main`)
**本文件用途**:一期增强的最终需求定稿,后续实现以本文件为唯一权威文本(经 `/grill-with-docs` 会话逐项确认)。

---

## 一、目标与范围

在现有单端口整合服务器(ADR-0001,已承载 read/search/mcp/sse)基础上做一期增强:

1. **Jina 全量路由挂载**:`/read/**` 全量透传给 jina 原生路由(含 `POST` 上传解析),补齐 query string 保留。
2. **read 缓存接入**:一级缓存(仅缓存解析后的 markdown),键 = uri + engine,TTL 300s 滑动续期,惰性删除 + 每小时兜底清理,in-flight 去重。
3. **MCP read 工具增强**:参数 `uri`/`skip`/`length`/`engine`/`timeout`;纯文本切片 + 截断提示;非 http(s) 返回提示词模板。
4. **MCP 工具描述 env 化**:全体工具、全体参数描述可经 `MCP_*` env 覆盖。
5. **README 手册化**:重组为使用手册,含文件解析章节(提示词模板的权威依据)。

**明确不在范围**:
- 非 http(s) 协议下载器(不实现 file/ftp/s3 等任何下载能力,理由见 ADR-0006)。
- MCP 工具 base64/bytes 参数、MCP prompts 机制、上传鉴权/大小限额(维持原汁原味)。

---

## 二、Jina 全量路由挂载

- 映射:`/read` → jina `/`、`/read/<rest>` → `/<rest>`;`/r` 完全同义;**任意 method**。
- `POST /read`(无尾路径)→ jina `POST /` = 原生文件上传解析(multipart `file` → Markdown)。
- **query string 保留(修复现有 bug)**:改写 `req.url` 时必须保留原始 query string,否则 `?foo=bar` 这类 URL 会丢失参数、缓存键也不完整。
- **bodyParser 分流**:全局 `@koa/bodyparser` 不得吞 `/read/**` 的 multipart body;按 Content-Type 分流。
- 路由边界:我们 `/`、`/health` 为本服务 health;`/read/**` 专属 jina(经 `/read` 可访问 jina 原生 `/` 行为)。
- 实现:沿用 `handleRead` 手动改写 `req.url` 模式(不引入 koa-mount),`ctx.respond=false` 交 jina koaApp。
- 改动:`src/server.ts`。

---

## 三、read 缓存(一级)

- **只缓存解析后的 markdown 全文**;不缓存原始字节(无独立 raw 缓存)。
- **键 = `uri(含 query string) + engine`**,联合唯一约束;engine 归一化为 `auto`/`browser`/`curl` 三值(对应 `X-Engine` 未传/`browser`/`curl`)。

  ```sql
  CREATE TABLE read_cache (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uri        TEXT NOT NULL,
    engine     TEXT NOT NULL,
    cache_path TEXT NOT NULL,
    expire_at  INTEGER NOT NULL,        -- epoch ms
    UNIQUE(uri, engine)
  );
  ```

- **TTL**:默认 300s,env `READ_CACHE_TTL`(秒)可配;命中后**滑动续期**(`expire_at = now + TTL`)。
- **清理**:惰性删除为主(访问到过期 uri 时删旧重抓);叠加**每小时定时兜底清理**(扫 `expire_at < now`,删行 + 删缓存文件)。定时清理只按时间戳删旧行,不误删并发写入。
- **只缓存成功响应**:jina 返回非 200 / 错误页不写缓存,避免缓存坏结果。
- **缓存层位置**:HTTP read 层(`handleRead`),HTTP 直连与 MCP self-call 共用。
- **`POST /read` 上传解析不缓存**(上传是一次性语义,缓存键依赖文件内容,保持简单)。
- **in-flight 去重**:粒度 = 缓存键(`uri+engine`);同键并发时共享同一个进行中的 Promise,完成后删除;不同 engine 不互相等待。
- 缓存命中瞬时返回,不占用 timeout 预算。
- 改动:`src/cache/sqlite.ts`、`src/server.ts`。

> **实测遗留缺陷(08 冒烟回填)**:`getOrFetchRead` 写缓存时 `putRead(uri, engine, content, ttlMs, now)` 的 `now` 取的是**请求开始时刻**(`getOrFetchRead` 参数默认值),而非写入完成时刻;当 loader(抓取)耗时 ≥ TTL 时,写出的 `expire_at = 请求开始 + TTL` 已过期 → 写入即失效。生产 TTL=300 下 loader 通常数秒,影响小;短 TTL 测试(如 5s)可触发。**修复建议**:`getOrFetchRead` 调 `putRead` 时改传 `Date.now()`(写入完成时刻),并同步调整宿主单测 `test/cache.test.js`「缓存过期后重新加载」对「loader 立即完成」的假设。

---

## 四、MCP read 工具

参数表:

| 参数 | 类型 | 默认 | 校验 |
|---|---|---|---|
| `uri` | string | 必填 | 见下 scheme 分流 |
| `skip` | int | 0 | 非负,负值 schema 拒绝 |
| `length` | int | 5000 | 1..50000,越界 schema 拒绝 |
| `engine` | enum | `auto` | `auto`/`direct`/`browser`(暂不含 `cf-browser-rendering`) |
| `timeout` | int(秒) | 见七 | 正整数,上限 600 |

**返回**:Markdown 的 `[skip, skip+length)` 切片(默认 5000 字符),纯文本。`GET /read/<uri>` 保持返回全文,切片仅 MCP 层。

**截断提示**:MCP 层有全文可精确判断;当 `skip+length < 全文长度` 时,切片尾部追加:
```
\n\n[内容已截断:全文约 {total} 字符,当前返回 {from}-{to}。可增大 length 或调 skip 续读剩余部分]
```
完整返回不加提示。

**并行**:一次只接受一个 uri,不支持数组/并行;agent 需并行时自行开 subagent 各调一次。

**scheme 分流**(实现层判断,非 schema 拒绝):
- `http(s)://` → jina 加载 + 解析,走缓存。
- 其他 scheme(file/ftp/s3/data…) → 返回统一提示词模板(见六),不尝试抓取。

**解析行为锚定**:解析为 LLM 友好的 Markdown 正文,**默认保留页面中所有链接 URL 与图片 URL**(markdown 语法,对应 jina 默认 `x-retain-links: all` + `x-retain-images: all`),**不递归嵌套解析**(不展开链接指向的内容)。

**engine 映射**:`direct` → `X-Engine: curl`;`browser` → `X-Engine: browser`;`auto` → 不传(后端默认组合策略)。

改动:`src/mcp/server.ts`。

---

## 五、MCP search 工具 + 描述 env 化

**search 工具行为锚定**(描述写入,不改逻辑):
- `type` 默认 `ai`(AI 语义搜索),显式 `type="web"` 切裸网页列表。
- `count` 钳制 1..50;`freshness` 非法值回退 `noLimit`。
- 工具内部异常统一返回可读错误文本,不抛错。
- search **不加 timeout 参数**(bocha 外部秒级 API,host 侧工具超时兜底)。

**描述 env 化**(全体工具、全体参数):
- 模式:`MCP_<TOOL>_DESC`(工具描述)、`MCP_<TOOL>_<PARAM>`(参数描述);缺省 = 现内建描述,env 有值覆盖。
- `src/config.ts` 建 `mcpDesc` 结构,显式枚举(类型安全);`createMcpServer` 经 deps 注入 `description`/`describe()`。
- 完整清单:

| 工具 | env | 对应 |
|---|---|---|
| search | `MCP_SEARCH_DESC` | 工具 description |
| search | `MCP_SEARCH_TYPE` / `MCP_SEARCH_QUERY` / `MCP_SEARCH_COUNT` / `MCP_SEARCH_FRESHNESS` | 各参数 |
| search | `MCP_SEARCH_INCLUDE`(单数,与代码参数一致) | `include` 参数 |
| search | `MCP_SEARCH_EXCLUDE` | `exclude` 参数 |
| read | `MCP_READ_DESC` | 工具 description |
| read | `MCP_READ_URI` / `MCP_READ_SKIP` / `MCP_READ_LENGTH` / `MCP_READ_ENGINE` / `MCP_READ_TIMEOUT` | 各参数 |

---

## 六、上传解析与提示词模板

**上传解析**(`POST /read`,`file` 字段):
- multipart/form-data 流式上传,支持 PDF / Word / Excel / PPT / HTML / 纯文本。
- 与网页抓取共享同一套 jina header 选项(`x-engine`、`x-retain-images`、`x-retain-links`、`Accept: application/json` 等)。
- 上传解析**不缓存**(见三)。
- 可选 body 字段:`page`(PDF 选页)、`url`(raw HTML 的 base url)。

**提示词模板**(非 http(s) uri 的返回,自包含,不依赖 README):
```
该资源的 scheme 无法由服务端直接抓取(服务端仅支持 http/https)。
请由你(agent)自行在本地下载该资源,再通过服务端的文件上传解析 API 取回 Markdown:

  curl -X POST {SERVER_URL}/read \
       -F 'file=@<本地文件路径>' \
       -H 'x-engine: auto' \
       -H 'x-retain-links: all' \
       -H 'x-retain-images: all'

参数解释(与服务端 read 工具功能对齐):
- -X POST                    上传解析走 POST
- {SERVER_URL}/read           服务端上传解析端点;{SERVER_URL} 即服务端对外地址
                             (当前 {SERVER_URL},默认 http://localhost:18081;云部署为公网地址)
- -F 'file=@<本地文件路径>'    以 multipart/form-data 上传文件,字段名固定 file;
                             支持 PDF / Word / Excel / PPT / HTML / 纯文本
- -H 'x-engine: auto'         解析引擎,对应 read 工具的 engine 参数:auto(默认,智能选择)/
                             direct(轻量无 JS)/ browser(浏览器渲染)
- -H 'x-retain-links: all'    保留页面中所有链接 URL(markdown 形式),默认全保留
- -H 'x-retain-images: all'   保留页面中所有图片 URL(markdown 形式),默认全保留

响应:返回该资源的 Markdown 正文,所有链接与图片 URL 均以 markdown 保留;
内容不递归嵌套解析(不展开链接指向的页面)。
```

- `{SERVER_URL}` 为渲染位,运行时由 `config.serverUrl` 注入(env `SERVER_URL`,默认 `http://localhost:18081`),不硬编码。
- 模板覆盖的 header 对齐 MCP 暴露的功能(engine + 链接/图片保留);MCP 未暴露的 jina 参数不进模板。

---

## 七、timeout 体系

分层三层,语义各自不同:

| 层 | 机制 | 语义 |
|---|---|---|
| jina 内部抓取 | `x-timeout`(≤180s,透传) | 软:等网络空闲或到点,超时返回已有内容 |
| HTTP 层整体 | `X-Read-Timeout` header / env `READ_TIMEOUT` | 硬:整体预算(加载 + 解析 + 返回),超时 504 |
| MCP 参数 | `timeout`(≤600s) | 硬:超时返回可读错误文本 |

- **MCP timeout 语义 = 「加载 web + 解析」整体预算**(一次 http(s) 读取);默认解析链:`timeout` 参数 > env `READ_TIMEOUT` > 内建 90s。
- **透传映射**:整体预算 clamp 到 180 后同时作为 jina `x-timeout` 传入,让 jina 内部预算与整体对齐(不出现 jina 还挂着、我们先 504 的错位)。
- **MCP self-call**:`read(uri, ..., timeout)` → fetch 带 `X-Read-Timeout: <秒>`;HTTP 层读取该 header 作为本次请求超时。
- **HTTP 层**:`X-Read-Timeout` header 为 per-request 超时(MCP self-call 与 REST 通用);缺省走 env `READ_TIMEOUT`(缺省 90s);超时 504。REST 调用方亦可用 `curl --max-time` 自控客户端等待。
- 超时 → 不写缓存;缓存命中瞬时返回不消耗预算。
- timeout 不参与缓存键。
- 改动:`src/server.ts`、`src/config.ts`。

---

## 八、README 手册化

结构:介绍 / 快速开始 / 配置(全部 env 表)/ API / 文件解析(上传)章节 / 缓存与超时 / 开发 / 参考。

- API-read 部分:全量挂载路由表、`POST /read` 上传、`?skip=` 说明、engine/timeout、非 http(s) 走文件解析章节。
- 文件解析章节 = 提示词模板的权威依据(与模板内容一致)。
- 配置表新增:`READ_CACHE_TTL`、`READ_TIMEOUT`、`SERVER_URL`、全部 `MCP_*`。

---

## 九、完整 env 清单

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `18081` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `JINA_APP` | `/app` | jina 镜像应用根目录 |
| `BOCHA_API_KEY` | — | 搜索密钥(必填) |
| `BOCHA_URL` | `https://api.bochaai.com` | bocha base-url |
| `SEARCH_READER_MCP_DATA` | `/app/extension/data` | 持久化目录 |
| `SQLITE_PATH` | `<dataDir>/cache.db` | sqlite 库路径 |
| `LOG_DIR` | `<dataDir>/.log` | 日志目录 |
| `READ_CACHE_TTL` | `300` | 缓存 TTL(秒) |
| `READ_TIMEOUT` | `90` | HTTP 层整体超时兜底(秒) |
| `SERVER_URL` | `http://localhost:18081` | 服务端对外地址(模板渲染) |
| `MCP_SEARCH_DESC` 等 | 内建描述 | 工具/参数描述覆盖(见五) |

---

## 十、文件改动清单

| 文件 | 改动 |
|---|---|
| `src/server.ts` | 全量挂载、query 保留、bodyParser 分流、缓存接入、in-flight 去重、timeout header、模板 fallback |
| `src/cache/sqlite.ts` | `read_cache` 表 + 读写/续期/清理 + in-flight 去重 |
| `src/config.ts` | `SERVER_URL`、`READ_TIMEOUT`、`READ_CACHE_TTL`、`mcpDesc` 结构 |
| `src/mcp/server.ts` | read 工具 uri/skip/length/engine/timeout、切片+截断提示、模板、描述 env 注入 |
| `docker-compose.yml` | 补 `READ_CACHE_TTL`、`READ_TIMEOUT`、`SERVER_URL`、`MCP_*` 注释 |
| `README.md` | 手册化重组 |
| `docs/smoke-test.md` | 扩展断言(见十一) |
| `docs/adr/` | 新增 0004~0007 |
| `docs/roadmap.md` | 删除本任务覆盖项(#1~#4) |
| `CONTEXT.md` | read 术语微调(见 ADR/术语核对) |

---

## 十一、测试计划

**单测(mock,不进容器)**:
- search 契约:query 必填、count 钳制、freshness 回退、include/exclude、错误路径。
- read 参数校验(zod):skip/length/timeout 越界拒绝。
- 切片 + 截断提示:精确判断、完整返回无提示。
- 缓存读写/滑动续期/定时清理/in-flight 去重。
- 非 http(s) uri 返回模板文本;`{SERVER_URL}` 渲染正确。
- timeout 错误文本。

**容器冒烟(smoke-test 扩展)**:
- `GET /read/<url>`(路径即 url,含 query 保留断言)。
- `POST /read` 上传(PDF/HTML)解析。
- 缓存命中/续期/失效重抓。
- MCP 工具调用:search、read(uri/skip/length/engine/timeout、截断、模板)。
- health。

---

## 十二、遗留(实现期实测)

已在容器冒烟(`docs/smoke-test.md`)完成:

1. bodyParser 是否吞 `/read/**` multipart stream → 已实测:`POST /read` 上传解析正常,multipart 原样透传(bodyParser 按 Content-Type 分流,未吞上传流)。
2. `req.url` 改写时 query string 透传正确性 → 已实测:带 query 的 URL 正常抓取;**实测发现:jina 会清理 `utm_source` 等追踪参数**(URL Source 只显示非 utm 参数),query 保留的强断言以宿主单测为准,容器断言用非 utm 参数。
3. docker exec 列 jina koaApp 实际路由清单 → 已实测:jina **不用 koa-router**(无 `router`/`_router`/`router.stack`),路由为 `registerRoutes()` 挂的中间件链;`serviceReady()` 后 `koaApp.middleware` 共 7 个(asyncHook / healthCheck / logging / anon CORS / compress / assets / **shimController**),核心分发是 shimController(把 path 当目标 URL)。探测命令见 smoke-test.md §6。
4. 上传解析对 `x-engine` 等 header 的实际支持 → 已实测:HTML 上传含链接+图片,`x-retain-links`/`x-retain-images: all` 生效。

**实测新发现(08 冒烟回填)**:

5. **MCP transport 单例缺陷(已修复)**:`src/server.ts` 原用单个 `StreamableHTTPServerTransport` 服务所有会话,而 SDK transport 单实例只支持一个会话(`sessionId`/`_initialized` 为实例字段);首个客户端 initialize 后,新客户端 initialize 被 400 `Server already initialized` 拒 → 服务退化为单客户端。**修复**:`/mcp` 改为**无状态模式**(`sessionIdGenerator: undefined`,每次请求独立 transport + server),天然多客户端且规避会话残留;`/sse` 保持连接级会话(每连接独立 transport,按连接隔离)。官方 SDK 真实客户端双会话实测通过,`scripts/mcp-smoke.mjs` 同步适配。
6. **缓存写 expire 基准缺陷**:见「三」末尾。

---

## 十三、ADR 清单(本会话产出)

- `docs/adr/0004-jina-full-route-mount.md` — Jina 全量路由挂载。
- `docs/adr/0005-read-cache.md` — read 缓存接入。
- `docs/adr/0006-non-http-uri-handling.md` — 非 http(s) 处理策略 + timeout 体系。
- `docs/adr/0007-error-as-prompt.md` — 报错即 prompt。
