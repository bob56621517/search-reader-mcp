# jina-ai/reader 模块化能力调研报告

> 调研日期:2026-08-19
> 调研对象:[jina-ai/reader](https://github.com/jina-ai/reader) `main` 分支(OSS 分支)
> 版本信息:仓库树 commit `1574bfd380d249c86c82db4dace0d9c8fe17e2b1`(2026-08-18);`package.json` version `0.5.0`;Node.js `>=22.15`。
> 说明:本仓库是 `https://r.jina.ai` / `https://s.jina.ai` 背后代码的**开源裁剪版**,SaaS 版才有的 MongoDB 存储层、真实限流、计费、用户系统均未包含(详见第五节"渐进式聚类")。

---

## 一、默认开启的功能清单

以下行为开箱即用(不设任何环境变量),全部在源码 `src/api/crawler.ts` / `src/api/searcher.ts` 中确认。

| 功能 | 说明 | 出处 |
|---|---|---|
| **URL → Markdown** (Read 核心,即 r.jina.ai) | 路由 `GET/POST /{url}`、`POST /`(body 传 `url`/`file`/`pdf`/`html`)。默认引擎 `auto`(headless Chrome 浏览器渲染 + curl-impersonate 轻量抓取智能组合)。输出默认 `content` 格式:先经 `@mozilla/readability` 清洗再转 Markdown,响应头带 `Title:`/`URL Source:` 等自定义文本头。 | `src/stand-alone/crawl.ts`;`src/api/crawler.ts` `crawl()`;README "Using request headers" |
| **PDF 解析** | 任意以 `.pdf` 结尾的 URL 用 PDF.js (`pdfjs-dist`) 解析转 Markdown;也支持 base64 或上传的 PDF。 | `src/services/pdf-extract.ts`;`src/services/binary-extractor.ts` |
| **MS Office 文档解析** | Word/Excel/PowerPoint 先经 LibreOffice (`soffice.ts`) 转 HTML/PDF 再走 HTML/PDF 管线。2025-12 起支持直接 `POST file` 字段上传二进制(无需先托管)。 | `src/services/soffice.ts`;`src/services/binary-extractor.ts`;README "Updates" |
| **Web 搜索** (Search 核心,即 s.jina.ai) | 路由 `GET/POST /search` 与 `GET/POST /{query}`。搜索 web、抓取结果页并复用 Read 管线转 Markdown(默认取前 5~6 条)。默认走自建 Google SERP 爬虫(`GoogleSERP`)+ 备选;`SERPER_SEARCH_API_KEY` 时优先用 serper.dev。**注意:没有内置 SearXNG / DuckDuckGo / 官方 Bing API。** | `src/stand-alone/search.ts`;`src/api/searcher.ts`;`src/services/serp/*` |
| **根路径索引页** | `GET /` 返回服务用法索引(`getIndex`),支持 `text/plain` 与 `application/json`。 | `src/api/crawler.ts` `getIndexCtrl()`;`src/api/searcher.ts` `search()` 空路径分支 |
| **CORS 全开** | `__CORSAllowAllMiddleware` 对所有来源放行。 | `src/services/registry.ts` `koaMiddlewares` |
| **robots.txt 尊重** | 默认遵守目标站点 robots.txt,可用 `x-robots-txt` 覆盖。 | `src/services/robots-text.ts`;`src/api/crawler.ts` |
| **HTTP/2 + HTTP 双监听** | `PORT` 上起 HTTP/2 h2c,`PORT+1` 上起普通 HTTP 备用端口。 | `src/stand-alone/crawl.ts` `h2c()` / `listen()` |
| **内网/本机免鉴权** | `ctx.ip` 命中私有网段(`10/8`、`172.16/12`、`192.168/16`、`127/8` 等,见 `isIPInNonPublicRange`)且转发层 ≤2 层时判定 `isInternal=true`,跳过鉴权。**公网匿名访问 crawl 也放行(但强制 `proxy=none`);search/serp 端点公网匿名访问会直接抛鉴权错误。** | `src/dto/base-auth.ts`;`src/utils/ip.ts`;`src/api/searcher.ts` |

### 需要特别注意的"默认行为"差异(OSS 与 SaaS)

- **缓存默认关闭**:OSS 默认 `noop-storage`(无状态),所有缓存/持久化方法返回空。只有配好对象存储才进"Stage 1 桶缓存"。`src/db/noop-storage.ts`、`src/config.ts`。
- **限流默认关闭**:`rateLimit()` 在 OSS 版(含 bucket 模式)恒返回空策略。`src/db/noop-storage.ts`、`src/db/bucket-storage.ts`。
- **本地全文索引搜索默认关闭**:`searchLocalIndex()`/`indexSnapshot()` 恒返回空,因此 `?provider=reader` 的"本地缓存搜索"在 OSS 版拿不到结果。`src/db/noop-storage.ts`、`src/db/bucket-storage.ts`、`src/api/searcher.ts` `readerLocalSearch()`。

---

## 二、可通过配置开启的模块清单

### 2.1 Search 模块(搜索)

- **开启方式**:以 `search` 入口运行(`node build/stand-alone/search.js`),或在同一服务内访问 `/search`、`/{query}`。package.json `exports` 提供 `./search`。
- **后端提供商**(`src/api/searcher.ts` `iterProviders()`,按优先级):
  | Provider | 触发条件 | 出处 |
  |---|---|---|
  | `SerperGoogleSearchService` | 设置 `SERPER_SEARCH_API_KEY` 时最高优先 | `src/services/serp/serper.ts`;`src/3rd-party/serper-search.ts` |
  | `GoogleSERP`(自建 Google 爬虫) | 默认可用 | `src/services/serp/google.ts` |
  | `BingSERP`(自建 Bing 爬虫) | 默认可用;`?provider=bing` 时优先 | `src/services/serp/bing.ts` |
  | `CommonGoogleSERP`(通用兜底) | 最后兜底 | `src/services/serp/common-serp.ts` |
  | `SerperBingSearchService` | `SERPER_SEARCH_API_KEY` + `provider=bing` | `src/services/serp/serper.ts` |
- **参数**(`src/api/searcher.ts` `search()`):
  - `type=web|images|news`(默认 web;images/news 计费权重更高)
  - `count`/`num`(默认 10,上限 20)
  - `provider`/`engine`(`google`/`bing`/`reader`)
  - `gl`(国家)、`hl`(语言)、`location`、`page`、`nfpr`、`fallback`
  - `site`、`ext`、`filetype`、`intitle`、`loc` 操作符(经 query 或 `x-site` 等 header 传入,`src/services/serper-search.ts` `GoogleSearchExplicitOperatorsDto`)
- **行为**:`cachedSearch()` 先查 SERP 结果缓存(默认有效 1h、保留 7d),未命中则调外部 provider 并存回缓存;之后对结果页逐个执行 Read 抓取(`fetchSearchResults`)。
- **鉴权注意**:公网匿名请求会 `AuthenticationRequiredError`(源码 `if (isAnonymous && !auth.isInternal) throw`)。OSS 版没有用户/API key 实现(`assertUser` 抛 `Not implemented`),因此**搜索端点实质上要求从内网/本机访问**。

### 2.2 LLM 视图模块(VLM / ReaderLM / 结构化输出)

- **开启方式(请求头/query)**:
  - `x-respond-with: vlm` 或 `x-engine: vlm` → 截图交给 VLM 转 Markdown。源码:header `vlm` 会改写为 `engine=browser, respondWith=vlm`(`src/dto/crawler-options.ts` `from()`)。
  - `x-respond-with: readerlm-v2` 或 `x-engine: readerlm-v2` → 用 ReaderLM 把 HTML 直接转 Markdown(不走 readability)。同样在 `crawler-options.ts` 中改写。
  - `x-with-generated-alt: true` → 用 VLM 给页面缺 alt 的图片生成说明(`![Image [idx]: [VLM_caption]](url)`),README "Generated alt" 一节。
  - **结构化输出**:POST body 传 `instruction` + `jsonSchema`,用 LLM 把页面提取为 JSON(`src/api/crawler.ts` + `src/services/common-llm/base.ts`)。`jsonSchema` 无对应 header,只能走 body。
- **LLM 服务商**(`src/services/envconfig.ts` `CONF_ENV` + `src/services/common-llm/*`):
  - OpenAI 兼容:`OPENAI_API_KEY`(`src/3rd-party/openai.ts` 固定指向 `https://api.openai.com/v1`)
  - Anthropic:`ANTHROPIC_API_KEY`(`src/3rd-party/anthropic.ts`)
  - OpenRouter:`OPENROUTER_API_KEY`(可 `importOpenRouterModel()` 动态导入模型,`src/services/common-llm/registry.ts`)
  - Google AI Studio:`GOOGLE_AI_STUDIO_API_KEY`(`src/3rd-party/google-gemini.ts`)
  - Vertex:`GCLOUD_PROJECT`(`src/services/common-llm/vertex-gemini.ts`)
  - Replicate:`REPLICATE_API_KEY`(`src/3rd-party/replicate.ts`)
- **模型映射**(`src/services/common-llm/registry.ts` 动态加载 `__dirname` 下模块):
  - `readerlm-v2`(`ReaderLM2`,继承 ChatGPT0613,windowSize=512000×0.8)与 `jina-vlm`(`JinaVLM`,vision 模型)——**OSS 版 `clients=[]`(内部 Cloud Run 客户端被注释),实际不可用**;如要启用需改代码接 OpenAI 兼容端点。
  - `vertex-gemini-3.1-flash-lite` 用于截图→Markdown(`src/services/lm.ts`)。
  - architecture.md 记载 SaaS 侧 VLM 为 `gemini-2.5-flash-lite`,与当前源码命名有出入,以源码为准。
- **LLM 管理**:`LLMManager` 支持多客户端、故障重试、streaming、function-calling、JSON 模式(`src/services/common-llm/base.ts`)。存在被注释的 `LLM_DISABLE_${M}` feature flag(注释标注 "FIXME: Does not work with esm")。

### 2.3 缓存模块(渐进式聚类)

- **Stage 0 无状态(默认)**:`StorageLayer`(`src/db/noop-storage.ts`)全部方法空实现。无缓存、无限流、无持久化。
- **Stage 1 桶缓存**:同时设置 `GCP_STORAGE_ENDPOINT` 与 (`GCP_STORAGE_BUCKET` 或 `GCLOUD_PROJECT`) 时,`src/config.ts` 自动切到 `BucketStorageLayer`(MinIO/S3/GCS 兼容,`src/db/bucket-storage.ts`;连接参数见 `src/services/default-bucket.ts`)。
  - 缓存对象(桶内 key 前缀):`page-cache/`(页面快照 + `snapshots/` 正文)、`serp-results/`(搜索缓存)、`image-alts/`(VLM 字幕)、`domain-blockade/`、`asn-blockade/`、`consecutive-error/`、`screenshots/{cacheId}/{page}`。
  - TTL(源码常量):`cacheValidMs = 1h`(页面缓存有效)、`cacheRetentionMs = 7d`(保留)、`pageCacheToleranceMs = 24h`(搜索侧容差)、`urlValidMs = 4h`(签名 URL 有效期)、`abuseBlockMs = 1h`。`src/api/crawler.ts`、`src/api/searcher.ts`。
- **Stage 2 MongoDB(不在 OSS)**:MongoDB Atlas 做索引与限流,仅 SaaS。README/architecture.md 明确 "MongoDB-backed SaaS storage layer is not included here"。
- **请求级缓存控制**:`x-cache-tolerance`(秒)、`x-no-cache: true`(= tolerance 0)、`x-cache-tolerance: 0`。某些选项会禁用缓存命中(`instruction`、`setCookies`、`injectPageScript`、`viewport`、`removeOverlay`、`detachInvisibles`,见 `isCacheQueryApplicable()`)。
- **本地文件缓存(待验证)**:`CONTRIBUTING.md` 提到 `CACHE_LOCAL_STORAGE_ROOT` 为本地文件缓存根,但**源码中未检索到该变量**,标注待验证。

### 2.4 代理模块

- ThorData 住宅代理:`THORDATA_PROXY_URL`(必)+ `THORDATA_PROXY_URL_ALT`(备),`src/services/proxy-provider/thordata.ts` 与 `index.ts`。
- BrightData:`BRIGHTDATA_PROXY_URL`/`BRIGHTDATA_ISP_PROXY_URL`/`BRIGHTDATA_SERP_API_KEY` 在 `src/services/proxy-provider/index.ts` **中已被注释**(`// import { BrightDataProxyProvider }`),当前不可用(待验证/已禁用)。
- 请求级:`x-proxy-url`(自定义代理)、`x-proxy`;SaaS 侧还有按国家分配。
- 国家偏好:`PREFERRED_PROXY_COUNTRY` 环境变量;未设置时从 `us/ca/gb/au/nz/sg` 随机挑。
- **匿名请求强制 `proxy=none`**(防滥用),`src/api/crawler.ts`。

### 2.5 抓取/渲染引擎模块

- `browser`:Puppeteer 无头 Chrome(默认,`src/services/puppeteer.ts`)。`DEBUG_BROWSER`(非无头调试)、`OVERRIDE_CHROME_EXECUTABLE_PATH`(指定 Chrome 二进制)。
- `curl`:curl-impersonate 轻量抓取,不执行 JS(`src/services/curl.ts`,4GB 上限、30s 超时、伪装 Chrome JA3 指纹)。
- `cf-browser-rendering`:Cloudflare Browser Rendering REST API(`src/services/cf-browser-rendering.ts` + `src/3rd-party/cloud-flare.ts`),需 `CLOUD_FLARE_API_KEY`(格式 `accountId:apiToken`),限流严格,README/architecture 定位为测试/兜底。
- 引擎选择:`x-engine: auto|browser|curl|cf-browser-rendering`(默认 `auto`)。

### 2.6 截图 / 页面快照

- `x-respond-with: screenshot`(视口)或 `pageshot`(整页)`:返回 302 跳转存储 URL,或直接 `image/png`(`_finalFormat()`)。截图写入桶的 `screenshots/{cacheId}/{page}`。
- 配合 `x-respond-timing: media-idle`、`x-with-iframe` 使用;`vlm` 也依赖截图。

### 2.7 Markdown 输出定制模块

- 图片/链接/媒体保留策略:`x-retain-images`(all/none/alt/all_p/alt_p)、`x-retain-links`(all/none/text/gpt-oss)、`x-retain-media`(link/none/text/image/html)。
- 汇总段:`x-with-links-summary`(true/all/gpt-oss)、`x-with-images-summary`。
- Markdown 风格(Turndown 透传):`x-md-link-style`(inlined/referenced/discarded)、`x-md-link-reference-style`(full/collapsed/shortcut/discarded)、`x-md-strong-delimiter`。
- 语义分块:`x-markdown-chunking`(true/h1~h5 按标题切;structured/s1~s5 结构化切,返回 JSON 数组或 `\x1e` 分隔文本)。
- 其他:`x-no-gfm`、`x-keep-img-data-url`、`x-base`(initial/final 链接基址)。
- 出处全部在 `src/dto/crawler-options.ts`(README 的 `x-retain-media` 细节与源码一致)。

### 2.8 预设(preset)模块

- 请求头 `x-preset`,取值 `reader|index|research|agent|spider`(`PRESET_NAMES`)。预设是一组 CrawlerOptions 覆盖,例如:
  - `reader`:retainImages=all、retainMedia=html、retainLinks=all、respondWith=frontmatter、detachInvisibles、removeOverlay、linkStyle=referenced。
  - `research`:retainImages=all、retainMedia=link、retainLinks=all、respondWith=markdown+frontmatter。
  - `index`:respondWith=frontmatter、markdownChunking=structured3。
- 出处:`src/dto/crawler-options.ts` `PRESET_OPTIONS`(其中 `agent`/`spider` 的具体值未在抓取片段中展开,待验证)。

### 2.9 其他可配置能力

| 能力 | 开启方式 | 说明/出处 |
|---|---|---|
| 自定义 JS 注入 | POST body `injectPageScript`/`injectFrameScript` | 注入后禁用缓存(`crawler-options.ts`) |
| 页面选择/等待/删除 | `x-target-selector`、`x-wait-for-selector`、`x-remove-selector` | 多个用 `, ` 分隔 |
| 响应时机 | `x-respond-timing`:html/visible-content/mutation-idle/resource-idle/media-idle/network-idle | 默认按 `presumedRespondTiming` 自动判断 |
| Token 截断/预算 | `x-max-tokens`(≥500,截断)、`x-token-budget`(超额拒绝) | `crawler-options.ts` |
| Cookies | `x-set-cookie`(解析 Set-Cookie 格式) | 有 cookies 时禁用缓存 |
| 语言/区域 | `x-locale`、`x-referer`、`x-user-agent`、`dnt` | — |
| 状态码断言 | `x-assert-status-code` | — |
| 视图端口 | POST body `viewport`(含注入脚本时禁用缓存) | — |
| 鉴权 | `Authorization: Bearer ...`(SaaS);OSS 内网免鉴权 | `src/dto/base-auth.ts` |
| 密钥打包 | `SECRETS_COMBINED` = base64(JSON) | 一次性解包到配置,`src/services/envconfig.ts` |
| 抓取卸载 | `JINA_CRAWLER_OFFLOAD_ORIGIN` | 把批量抓取转发给对等集群,`src/api/searcher.ts` `offloadScrapMany()` |
| 报告 | `SLACK_REPORT_WEBHOOK_URL` | CONTRIBUTING 提到,源码位置待定位 |

### 2.10 未在 OSS 源码实现 / 文档与源码不一致(重要)

| 项 | 状态 |
|---|---|
| `CACHE_LOCAL_STORAGE_ROOT`(本地文件缓存) | 仅 CONTRIBUTING.md 出现,**源码未检索到** → 待验证 |
| `JINA_SERP_API_KEY` / `JINA_SERP_API_ORIGIN` / `JINA_SERP_API_POLICY`(Jina SERP 后端) | 仅 CONTRIBUTING.md 出现,**源码未检索到** → 待验证 |
| `OVERRIDE_READERLM_V`、`OVERRIDE_MANAGE_SERVER_URL`、`OVERRIDE_GOOGLE_DOMAIN`、`OVERRIDE_BING_DOMAIN` | 仅 CONTRIBUTING.md 出现,源码中未定位到读取点 → 待验证 |
| `OVERRIDE_JINA_VLM_URL` | 只出现在 `src/3rd-party/internal-cloudrun.ts` 的**注释代码**里 → 当前不可用 |
| BrightData 代理 | `src/services/proxy-provider/index.ts` 中**被注释**,不可用 |
| `readerlm-v2` / `jina-vlm` 模型 | clients 为空(内部 Cloud Run 客户端被注释),OSS 开箱不可用 |
| `LLM_DISABLE_${M}` feature flag | 代码中被注释("Does not work with esm") |
| Search 本地索引(`provider=reader`) | `searchLocalIndex()` 空实现,OSS 无结果 |
| 限流 | OSS 版(含 bucket 模式)无真实限流 |
| `view=llm` 路由 | 不存在;LLM 视图通过 `x-respond-with`/`x-engine` 实现 |

---

## 三、环境变量 / 配置总表

> 依据:`src/services/envconfig.ts`(`CONF_ENV` 静态白名单 + `dynamic` 代理直读 `process.env`)、`CONTRIBUTING.md`、`Dockerfile`、各服务 init()。OSS 版真正生效的以**源码检索到**为准。

### 3.1 存储 / 缓存

| 变量 | 作用 | 默认值 | 源码出处 |
|---|---|---|---|
| `GCP_STORAGE_ENDPOINT` | 对象存储端点;设置后(与 BUCKET/GCLOUD_PROJECT 二选一)启用 Stage 1 桶缓存 | 未设置=无状态 | `src/config.ts`;`src/services/default-bucket.ts` |
| `GCP_STORAGE_BUCKET` | 缓存桶名 | `${GCLOUD_PROJECT}.appspot.com` | 同上 |
| `GCP_STORAGE_ACCESS_KEY` / `GCP_STORAGE_SECRET_KEY` | 对象存储凭据(本地 MinIO 用 root user/password) | 空 | 同上;`envconfig.ts` |
| `GCP_STORAGE_REGION` | 区域 | `us-central1` | 同上 |
| `GCLOUD_PROJECT` | GCP 项目;与 ENDPOINT 组合触发桶层;也是 Vertex/BlackHoleDetector 开关 | 空 | `src/config.ts`;`src/services/blackhole-detector.ts` |
| `CACHE_LOCAL_STORAGE_ROOT` | 本地文件缓存根(替代对象存储) | — | **仅文档,源码未见** |

### 3.2 搜索 / SERP

| 变量 | 作用 | 源码出处 |
|---|---|---|
| `SERPER_SEARCH_API_KEY` | serper.dev 搜索 key,开启 Serper Google/Bing provider | `src/services/serper-search.ts`;`src/services/serp/serper.ts` |
| `JINA_SERP_API_KEY` / `JINA_SERP_API_ORIGIN` / `JINA_SERP_API_POLICY` | Jina SERP 后端与路由策略 | **仅文档,源码未见** |
| `THORDATA_SERP_API_KEY` | ThorData SERP API(provider 内部) | `envconfig.ts`(key 白名单);provider 主体待定位 |

### 3.3 代理

| 变量 | 作用 | 源码出处 |
|---|---|---|
| `THORDATA_PROXY_URL` / `THORDATA_PROXY_URL_ALT` | ThorData 住宅代理(主/备) | `src/services/proxy-provider/index.ts`、`thordata.ts` |
| `BRIGHTDATA_PROXY_URL` / `BRIGHTDATA_ISP_PROXY_URL` / `BRIGHTDATA_SERP_API_KEY` | BrightData 代理+SERP | `envconfig.ts`;provider 代码被注释 |
| `PREFERRED_PROXY_COUNTRY` | 代理国家偏好 | `src/services/proxy-provider/index.ts` `alloc()` |
| `http_proxy` | OpenAI 兼容客户端的全局出站代理 | `src/3rd-party/openai-compat.ts` |

### 3.4 LLM / VLM

| 变量 | 作用 | 源码出处 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI 兼容 chat/completions | `src/services/common-llm/gpt-35.ts`;`src/3rd-party/openai.ts` |
| `ANTHROPIC_API_KEY` | Anthropic | `src/3rd-party/anthropic.ts` |
| `OPENROUTER_API_KEY` | OpenRouter(可动态导入模型) | `src/services/common-llm/registry.ts`;`src/3rd-party/open-router.ts` |
| `GOOGLE_AI_STUDIO_API_KEY` | Gemini | `src/services/common-llm/google-gemini.ts`;`src/3rd-party/google-gemini.ts` |
| `REPLICATE_API_KEY` | Replicate | `src/3rd-party/replicate.ts` |
| `GCLOUD_PROJECT` | Vertex Gemini | `src/services/common-llm/vertex-gemini.ts` |
| `OVERRIDE_JINA_VLM_URL` | 指向不同 VLM 端点 | 仅注释代码(`internal-cloudrun.ts`) |
| `OVERRIDE_READERLM_V` | 切换 ReaderLM 版本 | 仅文档,源码未见 |

### 3.5 浏览器 / 渲染

| 变量 | 作用 | 默认 | 源码出处 |
|---|---|---|---|
| `DEBUG_BROWSER` | 非无头模式(调试) | 假 | `src/services/puppeteer.ts`;`src/services/serp/puppeteer.ts` |
| `OVERRIDE_CHROME_EXECUTABLE_PATH` | 指定 Chrome 二进制 | 无(Docker 内设 `/usr/bin/google-chrome-stable` 或 `/usr/bin/chromium`) | 同上;`Dockerfile` |
| `CLOUD_FLARE_API_KEY` | CF Browser Rendering(`accountId:apiToken`) | 无 | `src/services/cf-browser-rendering.ts` |

### 3.6 服务 / 运行

| 变量 | 作用 | 默认 | 源码出处 |
|---|---|---|---|
| `PORT` | 监听端口(HTTP/2) | 3000(`Dockerfile` 设 8080) | `src/stand-alone/crawl.ts` 等 |
| `NODE_ENV` | `dry-run` 离线预热/启动;`prod` 开黑洞检测;`test` 加 `--no-sandbox` | 无 | 各 standalone;`puppeteer.ts` |
| `JINA_CRAWLER_OFFLOAD_ORIGIN` | 抓取卸载到对等集群 | 无 | `src/api/searcher.ts` |
| `JINA_BOGO_SITES_RESORT_ORIGIN` | bogo-sites 恢复源 | 无 | `src/services/bogo-sites.ts` |
| `SLACK_REPORT_WEBHOOK_URL` | 运行时报告 Slack 频道 | 无 | CONTRIBUTING(源码待定位) |
| `SECRETS_COMBINED` | base64 JSON 打包多个密钥 | 无 | `src/services/envconfig.ts` |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_KEY` | 计费(SaaS) | 无 | `envconfig.ts`;`package.json` 依赖 `stripe` |
| `NODE_COMPILE_CACHE` | Node 编译缓存(镜像内预烧) | 镜像内 `node_modules` | `Dockerfile` |
| `OVERRIDE_GOOGLE_DOMAIN` / `OVERRIDE_BING_DOMAIN` | 地区搜索域名 | 无 | 仅文档,源码未见 |
| `OVERRIDE_MANAGE_SERVER_URL` | 管理服务器地址 | 无 | 仅文档,源码未见 |

### 3.7 请求级配置(header / query,非环境变量但同样是"模块开关")

`x-respond-with`(content/markdown/html/text/screenshot/pageshot/frontmatter/markdown+frontmatter/vlm/readerlm-v2/no-content)、`x-engine`(auto/browser/curl/cf-browser-rendering;特殊值 `vlm`/`readerlm-v2` 会改写 respondWith)、`x-preset`、`x-with-generated-alt`、`x-retain-images`、`x-retain-links`、`x-retain-media`、`x-with-links-summary`、`x-with-images-summary`、`x-markdown-chunking`、`x-md-*`、`x-cache-tolerance`、`x-no-cache`、`x-target-selector`、`x-wait-for-selector`、`x-remove-selector`、`x-timeout`(≤180s)、`x-respond-timing`、`x-max-tokens`、`x-token-budget`、`x-proxy-url`、`x-proxy`、`x-set-cookie`、`x-user-agent`、`x-locale`、`x-referer`、`x-base`、`x-robots-txt`、`x-page`、`x-no-gfm`、`x-keep-img-data-url`、`x-with-iframe`、`x-with-shadow-dom`、`x-assert-status-code`、`dnt`。POST body 另有:`url`、`html`、`file`、`pdf`、`instruction`、`jsonSchema`、`injectPageScript`、`injectFrameScript`、`viewport`、`setCookies`。(出处:`src/dto/crawler-options.ts` `CrawlerOptions` 与 `from()`)

---

## 四、Docker 部署相关配置

- **Dockerfile**(`Dockerfile`,源码确认):
  - 基础镜像 `node:24`;按 `TARGETARCH` 分叉:
    - `amd64`:装 Google Chrome stable + LibreOffice + CJK 字体 + zstd,`OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`;
    - `arm64`:装 chromium + LibreOffice + 字体,`OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/chromium`。
  - 非 root 用户 `jina`;`npm ci` 后拷贝 `build`/`public`/`licensed`;用 `npm run dry-run`(`NODE_ENV=dry-run node build/stand-alone/search.js`)预热 `NODE_COMPILE_CACHE=node_modules`。
  - `ENV PORT=8080`;`EXPOSE 8080 8081`;`ENTRYPOINT ["node"]`;`CMD ["build/stand-alone/crawl.js"]`(即默认跑 **Read/crawl** 服务,不是 search)。
- **镜像**:README "Self-host with Docker" → `ghcr.io/jina-ai/reader:oss`,内置 Chrome、LibreOffice、CJK 字体。
- **docker-compose.yml**:仅起 `minio`(MinIO 对象存储,9000/9001),用于 Stage 1 桶缓存;别名 `minio.dev.jina.ai`。**未定义 reader 服务本身**,需自行把镜像与 `GCP_STORAGE_ENDPOINT=http://minio:9000`、`GCP_STORAGE_ACCESS_KEY=minio`、`GCP_STORAGE_SECRET_KEY=minio123` 接起来。
- **三个可执行入口**(package.json `exports` / `src/stand-alone/*`):
  - `build/stand-alone/crawl.js` — Read 服务(默认);
  - `build/stand-alone/search.js` — Search 服务(仅搜索路由,启动时剔除 `crawl` tags);
  - `build/stand-alone/serp.js` — 纯 SERP 服务(仅搜索,不抓正文,`src/api/serp.ts`)。
- **Node 版本要求**:`engines.node >=22.15`(CONTRIBUTING 写 22+)。

---

## 五、对 search-reader-mcp 扩展的启示

结合本项目"扩展 jina-reader 镜像 + 自定义搜索 + MCP 服务"的定位,以下为可接入点与风险点(均基于源码事实):

1. **Search 端点值得直接复用**:`/search` 已具备"搜索 + 抓取 top N 正文"能力,provider 可配 Serper(key)或默认自建 Google/Bing 爬虫。search-reader-mcp 的 MCP search 工具可考虑代理该端点,而非重复实现抓取。
2. **必须绕过的坑:OSS 版 search 的公网鉴权行为**。`SearcherHost.search` 对 `isAnonymous && !isInternal` 直接抛错。若 MCP 服务与 reader 同进程/同内网部署则无碍;若跨网络,需自行处理(内网放行或自建鉴权)。
3. **缓存接入价值高**:配一个 MinIO(compose 已给)即获得页面快照 + SERP 结果缓存(默认 1h 有效),对应本项目 ADR-0005(read cache)可参考其 TTL 常量与 `x-cache-tolerance`/`x-no-cache` 语义。
4. **LLM 视图可扩展但默认不可用**:`x-respond-with: vlm`/`readerlm-v2` 的路由与改写逻辑都在,但 OSS 版 `readerlm-v2`/`jina-vlm` 的客户端是空的;若想启用,需要在 `common-llm/*` 补 OpenAI 兼容端点(如自建 vLLM/Ollama 后把 `ChatGPT0613` 子类 clients 指向自建 baseURL),或把 `OPENAI_API_KEY` 配到现成模型。
5. **VLM 图片字幕**是低成本高价值功能(`x-with-generated-alt`),配一个 OpenAI/Gemini key 即可生效,建议优先接入。
6. **不要依赖 OSS 的本地索引搜索(`provider=reader`)与限流**,那是 Stage 2(MongoDB)能力;若要全文索引,需自建(本项目的 MCP 搜索本身就是这个缺口)。
7. **文档与源码不一致的变量**(`CACHE_LOCAL_STORAGE_ROOT`、`JINA_SERP_*`、`OVERRIDE_READERLM_V`、`OVERRIDE_MANAGE_SERVER_URL` 等)在落地前应回到对应 commit 的源码核实,避免踩空。
8. **多入口部署**:可把 Read(crawl)、Search(search)、纯 SERP(serp)拆成三个容器/进程,按需伸缩——镜像默认只跑 crawl;search 入口需显式指定。

---

## 六、参考来源

基于 jina-ai/reader `main` 分支,commit(tree) `1574bfd380d249c86c82db4dace0d9c8fe17e2b1`(2026-08-18)。以下均为 `raw.githubusercontent.com/jina-ai/reader/main/...`(或 GitHub 对应 blob 页)。

| 文件 | 关键结论 |
|---|---|
| `README.md` | Read/Search 用法、全部 `x-*` headers、`ghcr.io/jina-ai/reader:oss`、OSS=SaaS 裁剪说明 |
| `architecture.md` | 架构总览、多引擎、HTML→MD profiles、渐进式聚类 Stage 0/1/2、Vendor 特性(Proxy/SERP/VLM)、SaaS 部署拓扑 |
| `CONTRIBUTING.md` | 本地开发、**环境变量总表**(含仅文档存在的变量) |
| `package.json` | version 0.5.0、三个入口(exports)、依赖(puppeteer/pdfjs/minio/lru-cache/tiktoken/stripe 等) |
| `Dockerfile` | 多架构构建、Chrome/LibreOffice/字体、PORT=8080、入口 `build/stand-alone/crawl.js` |
| `docker-compose.yml` | 仅 MinIO(Stage 1 缓存) |
| `src/config.ts` | `STORAGE_CLS` 选择:noop vs Bucket(由 `GCP_STORAGE_ENDPOINT`+BUCKET/GCLOUD_PROJECT 触发) |
| `src/services/envconfig.ts` | `CONF_ENV` 静态密钥白名单、`SECRETS_COMBINED`、`dynamic` 直读 env |
| `src/db/noop-storage.ts` / `src/db/bucket-storage.ts` | Stage 0 空实现 / Stage 1 桶 key 布局;rateLimit 与本地索引均为 no-op |
| `src/services/default-bucket.ts` | MinIO/S3/GCS 连接参数解析 |
| `src/api/crawler.ts` | Read 路由、TTL 常量(1h/7d/4h/1h/30d)、缓存命中条件、匿名强制 no-proxy、screenshot/pageshot 输出 |
| `src/api/searcher.ts` | Search 路由、provider 迭代、SERP 缓存、`readerLocalSearch`、`JINA_CRAWLER_OFFLOAD_ORIGIN`、公网匿名鉴权 |
| `src/api/serp.ts` | 纯 SERP host(provider 仅 google/bing) |
| `src/dto/crawler-options.ts` | `CrawlerOptions` 全字段、`x-*` header 解析、preset、`vlm`/`readerlm-v2` 改写、`CONTENT_FORMAT`/`ENGINE_TYPE`/`PRESET_NAMES` |
| `src/dto/base-auth.ts` / `src/utils/ip.ts` | 鉴权 DTO、内网 IP 判定 |
| `src/services/registry.ts` | CORS 全开、body 上限 102MB、RPC 注册 |
| `src/services/common-llm/*`(registry/base/gpt-35/reader-lm/jina-vlm/vertex-gemini 等) | LLM 管理器、OpenAI 兼容客户端、`readerlm-v2`/`jina-vlm` 空 clients、模型别名 |
| `src/services/lm.ts` | 截图→Markdown、ReaderLM→Markdown、结构化 JSON 提取 |
| `src/services/serp/*`、`src/3rd-party/serper-search.ts` | 各 SERP provider 与查询操作符(site/ext/filetype/intitle/loc) |
| `src/services/proxy-provider/index.ts`、`thordata.ts` | ThorData 代理、BrightData 被注释、`PREFERRED_PROXY_COUNTRY` |
| `src/services/puppeteer.ts`、`curl.ts`、`cf-browser-rendering.ts` | 三大抓取引擎与环境变量 |
| `src/3rd-party/openai.ts`、`openai-compat.ts`、`internal-cloudrun.ts` | OpenAI 固定端点、http_proxy、被注释的内部服务端点(`OVERRIDE_JINA_VLM_URL`) |

### 未能从源码完整确认的论断(待验证)

1. `CACHE_LOCAL_STORAGE_ROOT`、`JINA_SERP_API_KEY/ORIGIN/POLICY`、`OVERRIDE_READERLM_V`、`OVERRIDE_MANAGE_SERVER_URL`、`OVERRIDE_GOOGLE_DOMAIN`、`OVERRIDE_BING_DOMAIN`:仅在 `CONTRIBUTING.md` 出现,`src/` 下未检索到读取点,可能来自上游 SaaS 或 `dynamic` 代理隐式读取(`envconfig.ts` 的 `dynamic` 会直接 `process.env[prop]`,故仍可能生效但无类型化消费)。
2. `agent`/`spider` 两个 preset 的具体取值:仅确认存在于 `PRESET_NAMES`,具体覆盖字段未展开。
3. `SLACK_REPORT_WEBHOOK_URL` 的具体消费点:文档提及,源码定位未完成。
4. README 中 `x-retain-media` 之后的原文(至文末)受抓取工具输出长度限制未逐字读取;但相关 headers 已通过 `crawler-options.ts` 与 grep 交叉确认,不影响结论。
5. BrightData 三个变量在 `envconfig.ts` 静态白名单中存在,但 provider 代码被注释——若配置了也不会被使用(除非改源码)。
