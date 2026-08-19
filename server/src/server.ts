import bodyParser from '@koa/bodyparser';
import Koa from 'koa';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { BochaClient } from './bocha/client';
import { CacheDb } from './cache/sqlite';
import { Config } from './config';
import { JinaReaderBridge } from './jina/reader';
import { DailyLogger } from './log/daily';
import { ReadUrlOptions, createMcpServer } from './mcp/server';
import { engineHeaderValue, normalizeEngine } from './mcp/read-tools';
import { TOOL_ANNOTATIONS } from './mcp/annotations';

/**
 * 整合服务器(ADR-0001):单端口承载 read/、search/、mcp/、sse/。
 * createApp 只组装 koa app 不 listen,便于测试(supertest)与启动(index)共用。
 *
 * 路由形态:
 *   read   GET /read/<url> | /r/<url>           路径即 url(全量挂载,v7#03)
 *          POST /read(无尾路径)                  原生上传解析(multipart file → Markdown),不缓存
 *   search GET /search/ai/<query> | /s/<query>  路径即 query(ai)
 *          GET /search/web/<query>              (web)
 *          POST /search/ai | /s | /search/web   JSON body { query, count?, freshness?, ... }
 *   mcp    GET/POST/DELETE /mcp                 streamable HTTP
 *   sse    GET /sse + POST /messages            legacy SSE
 */
export interface AppDeps {
  config: Config;
  /** 未传或 null 时 read/ 返回 503(测试/降级场景) */
  jina?: JinaReaderBridge | null;
}

const READ_UNAVAILABLE = 'read 不可用:jina 桥接未初始化';

/** 兜底清理周期:每小时(v7#02 定时清理) */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** jina x-timeout 透传上限(spec「七」:整体预算 clamp 到 180 后透传) */
const JINA_TIMEOUT_CAP = 180;

export async function createApp(deps: AppDeps): Promise<Koa> {
  const config = deps.config;
  // read 一级缓存(v7#02 基础设施,v7#03 接入):HTTP read 层与 MCP self-call 共用
  const cache = CacheDb.open(config.sqlitePath);
  cache.startSweeper(SWEEP_INTERVAL_MS);
  const logger = new DailyLogger(config.logDir);
  const bocha = new BochaClient({ apiKey: config.bocha.apiKey, baseUrl: config.bocha.baseUrl });
  const jina = deps.jina ?? null;

  // readUrl:供 MCP read 工具复用本服务 read/ 路由(self-call,路径即 url)
  // opts.engine 映射 X-Engine header(direct→curl、browser→browser、auto→不传);
  // opts.timeout 为整体预算,以 X-Read-Timeout 传给 HTTP 层(缺省由 config.readTimeout 兜底);
  // 非 2xx(含 504 超时)转可读错误文本,不抛错,由 MCP 层返回。
  const readUrl = async (url: string, opts: ReadUrlOptions = {}): Promise<string> => {
    if (!jina) return READ_UNAVAILABLE;
    const headers: Record<string, string> = {};
    const engine = engineHeaderValue(opts.engine);
    if (engine) headers['X-Engine'] = engine;
    if (opts.timeout !== undefined) headers['X-Read-Timeout'] = String(opts.timeout);
    const res = await fetch(`http://127.0.0.1:${config.port}/r/${encodeURIComponent(url)}`, { headers });
    if (res.status >= 400) {
      return `读取失败:HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
    }
    return res.text();
  };

  // MCP server 工厂:每传输/每会话独立实例,避免单 Server 多 connect 互相覆盖(SDK 单传输语义)
  const makeMcp = () => createMcpServer({ bocha, readUrl, config });

  // mcp/ 走 streamable HTTP(无状态模式):不生成 sessionId,每次请求独立 transport + server。
  // read/search 均为纯请求-响应,无跨调用状态需求;无状态天然支持多客户端,也规避了有状态
  // 单例实例的会话残留(旧实现首个会话 initialize 后,新会话被 400 拒 "Server already initialized")。
  // SSE(/sse)为 legacy 兼容保留:连接即会话,天然按连接隔离、支持多客户端,无需无状态化。
  const handleMcp = async (ctx: Koa.Context, parsedBody: unknown): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await makeMcp().connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, parsedBody);
  };

  // sse/ 为 legacy SSE:每个 GET /sse 建立独立 server + 传输
  const sseSessions = new Map<string, SSEServerTransport>();

  const app = new Koa();
  // bodyParser 按 Content-Type 分流:@koa/bodyparser v6 默认只解析 json/form,
  // 本就吞不掉 multipart。此处显式放行两类 read 请求(bodyParser 不解析、不消耗 stream):
  //   1. read 的 multipart 上传流(POST /read,原样交 jina 原生上传解析);
  //   2. 带 URL 路径的 read POST(POST /read/<url>):真实 jina 下若外层先解析 JSON body
  //      (消费 stream),jina 内层再读同一流会 499 "Request already closed";故不解析,
  //      选项经 header(X-Engine / X-Read-Timeout)传递,与 GET 契约及 MCP self-call 一致。
  // 其余 JSON(如 POST /search/...)留给 search。
  const parseBody = bodyParser();
  app.use(async (ctx, next) => {
    const path = ctx.path;
    const ct = ctx.get('content-type') || '';
    const isReadRoute =
      path === '/read' || path.startsWith('/read/') || path === '/r' || path.startsWith('/r/');
    const isReadMultipart = isReadRoute && ct.includes('multipart/form-data');
    const isReadUrlPost =
      ctx.method === 'POST' &&
      isReadRoute &&
      !ct.includes('multipart/form-data') &&
      (path.startsWith('/read/') || path.startsWith('/r/'));
    if (isReadMultipart || isReadUrlPost) return next();
    return parseBody(ctx, next);
  });
  app.use(async (ctx) => {
    const startedAt = Date.now();
    const p = ctx.path;
    // 精确匹配端点兼容尾斜杠(/mcp/ 与 /mcp 等价);read/search 路径即内容不受影响
    const exact = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
    const method = ctx.method;
    try {
      // ---- MCP streamable HTTP ----
      if (exact === '/mcp') {
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
          ctx.status = 405;
          ctx.body = { error: 'Method Not Allowed' };
          return;
        }
        ctx.respond = false;
        await handleMcp(ctx, (ctx.request as any).body);
        return;
      }
      // ---- MCP legacy SSE ----
      if (exact === '/sse' && method === 'GET') {
        const tx = new SSEServerTransport('/messages', ctx.res);
        sseSessions.set(tx.sessionId, tx);
        ctx.res.on('close', () => sseSessions.delete(tx.sessionId));
        ctx.respond = false;
        // SSEServerTransport 的响应头在 start() 里写;McpServer.connect 不会自动调用
        await tx.start();
        await makeMcp().connect(tx);
        return;
      }
      if (exact === '/messages' && method === 'POST') {
        const tx = sseSessions.get(String(ctx.query.sessionId ?? ''));
        if (!tx) {
          ctx.status = 404;
          ctx.body = { error: 'Session not found' };
          return;
        }
        ctx.respond = false;
        await tx.handlePostMessage(ctx.req, ctx.res);
        return;
      }
      // ---- read:全量挂载(任意 method;GET 走缓存,POST /read 上传不缓存) ----
      if (p === '/r' || p.startsWith('/r/') || p === '/read' || p.startsWith('/read/')) {
        await handleRead(ctx, jina, cache, config);
        return;
      }
      // ---- search ----
      const route = parseSearchRoute(p);
      if (route) {
        await handleSearch(ctx, bocha, route.type, route.pathQuery);
        return;
      }
      // ---- catalog:工具目录元数据(ADR-0009,desc/hints 单一来源;仅 GET) ----
      if (exact === '/catalog') {
        if (method !== 'GET') {
          ctx.status = 405;
          ctx.body = { error: 'Method Not Allowed' };
          return;
        }
        ctx.body = {
          tools: [
            { name: 'search', description: config.mcpDesc.search.description, annotations: TOOL_ANNOTATIONS },
            { name: 'read', description: config.mcpDesc.read.description, annotations: TOOL_ANNOTATIONS },
          ],
        };
        return;
      }
      // ---- health ----
      if (exact === '/' || exact === '/health') {
        ctx.body = { service: 'search-reader-mcp', status: 'ok' };
        return;
      }
      ctx.status = 404;
      ctx.body = { error: 'Not Found' };
    } catch (e) {
      logger.error(`请求异常 ${ctx.method} ${ctx.path}: ${(e as Error).message}`);
      ctx.status = 500;
      ctx.body = { error: (e as Error).message };
    } finally {
      logger.info(`${ctx.method} ${ctx.path} ${ctx.status} ${Date.now() - startedAt}ms`);
    }
  });

  return app;
}

// ---- read 路由:v7#03 全量挂载(任意 method)+ query 保留 + 缓存接入 + timeout ----
// 挂载映射:`/read` → jina `/`、`/read/<rest>` → `/<rest>`;`/r` 完全同义。
//   - 带 URL 路径(任意 method;GET|POST 等价,jina 契约):接入 read_cache(键 = uri 含 query + engine 归一化);
//     命中直接返回全文(不占 timeout 预算),miss 走 jina 抓取,成功(200)写缓存;非 200 / 超时不写缓存。
//   - 无尾路径(`/read` 或 `/r`):透传 jina `/`(GET 原生根、POST multipart 上传解析),不缓存。
//   - 统一走 jinaFetch:所有路径都经捕获响应 + 整体硬超时(X-Read-Timeout,缺省 config.readTimeout);
//     改写 req.url 保留原始 query string(修复丢 query bug)。
// 注意:真实 jina 的响应形态在容器冒烟(docs/smoke-test.md)验证,CaptureResponse 为最小替身。

async function handleRead(
  ctx: Koa.Context,
  jina: JinaReaderBridge | null,
  cache: CacheDb,
  config: Config,
): Promise<void> {
  const p = ctx.path;
  const prefix = p.startsWith('/read') ? '/read' : '/r';
  // 路径剩余即目标 URL(可能带前导 / 或已编码),去前导斜杠后作为干净 URL
  const target = decodePathQuery(p.slice(prefix.length)).replace(/^\/+/, '');
  // 原始 query string(未解码),改写 req.url 时必须保留
  const qs = ctx.querystring;

  if (!jina) {
    ctx.status = 503;
    ctx.body = { error: READ_UNAVAILABLE };
    return;
  }

  // 整体硬超时预算(秒),所有路径共用
  const budgetSec = readBudgetSec(ctx, config.readTimeout);

  // 无尾路径:透传 jina `/`(任意 method;POST /read 上传解析、GET /read 原生根),不缓存
  if (!target) {
    const jinaUrl = '/' + (qs ? '?' + qs : '');
    await respondFromJina(ctx, jina, jinaUrl, budgetSec);
    return;
  }

  // 完整目标 URL(含 query),缓存键的 uri 部分
  const fullUri = target + (qs ? '?' + qs : '');

  // 带 URL 路径(任意 method;GET|POST 等价,ADR-0004 + jina 契约):接入 read_cache。
  // 无尾路径(上传解析)已在上方 return,不缓存;键 = uri(含 query)+ engine。
  // engine/timeout 选项:POST 可带选项 body(统一走 POST),缺省回退 header(既有 GET 契约)。
  const engine = normalizeEngine(readOption(ctx, 'engine', 'x-engine'));
  // 透传 engine 给 jina:POST 选项统一入 body(US16),HTTP 层需转成 jina 认识的 X-Engine header
  // (归一化值即 header 值:browser / curl),auto 不传;jinaFetch 不改写此 header。
  if (engine !== 'auto') ctx.req.headers['x-engine'] = engine;
  const ttlMs = config.readCacheTtl * 1000;
  try {
    const content = await cache.getOrFetchRead(fullUri, engine, ttlMs, async () => {
      const cap = await jinaFetch(ctx, jina, '/' + fullUri, budgetSec);
      // 只缓存成功响应:jina 非 200 抛错 → 不写缓存
      if (cap.statusCode !== 200) throw new JinaNonOkError(cap);
      return cap.body;
    });
    ctx.status = 200;
    ctx.type = 'text/markdown; charset=utf-8';
    ctx.body = content;
  } catch (e) {
    if (e instanceof JinaNonOkError) {
      respondCaptured(ctx, e.cap);
      return;
    }
    if (e instanceof ReadTimeoutError) {
      ctx.status = 504;
      ctx.body = { error: `read 超时(整体预算 ${budgetSec}s 已耗尽)` };
      return;
    }
    throw e;
  }
}

/** 透传 jina(不缓存):jinaFetch 拿响应后原样转发状态/响应头/body;超时 504 */
async function respondFromJina(
  ctx: Koa.Context,
  jina: JinaReaderBridge,
  jinaUrl: string,
  budgetSec: number,
): Promise<void> {
  try {
    const cap = await jinaFetch(ctx, jina, jinaUrl, budgetSec);
    respondCaptured(ctx, cap);
  } catch (e) {
    if (e instanceof ReadTimeoutError) {
      ctx.status = 504;
      ctx.body = { error: `read 超时(整体预算 ${budgetSec}s 已耗尽)` };
      return;
    }
    throw e;
  }
}

/** 把捕获的 jina 响应转发给客户端:状态码 + content-type + body(空 body 不设置,避免 koa 改状态码) */
function respondCaptured(ctx: Koa.Context, cap: CaptureResponse): void {
  const ct = cap.headers['content-type'];
  ctx.status = cap.statusCode;
  if (typeof ct === 'string') ctx.type = ct;
  if (cap.body) ctx.body = cap.body;
}

/** 整体硬超时(秒):POST body timeout(选项入 body)优先,回退 X-Read-Timeout header,缺省 config.readTimeout;非法值回退默认 */
function readBudgetSec(ctx: Koa.Context, fallback: number): number {
  const bt = Number((ctx.request as any).body?.timeout);
  if (Number.isFinite(bt) && bt > 0) return bt;
  const v = Number(ctx.get('x-read-timeout'));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 选项取值:POST body(POST 选项入 body,统一走 POST)优先,缺省回退 header(既有 GET 契约) */
function readOption(ctx: Koa.Context, bodyKey: string, headerName: string): string {
  const body = (ctx.request as any).body as Record<string, unknown> | undefined;
  const bv = body?.[bodyKey];
  if (bv != null && String(bv).trim() !== '') return String(bv);
  return ctx.get(headerName);
}

/**
 * 经 jina 抓取:用捕获响应替代 ctx.res,拿到 status/body;
 * 整体预算(秒)内等待,超时抛 ReadTimeoutError;整体预算 clamp 到 180 后透传为 jina x-timeout。
 * finally 恢复 ctx.req.url 与 x-timeout header(即使 jina.handler 同步抛错也不残留)。
 */
async function jinaFetch(
  ctx: Koa.Context,
  jina: JinaReaderBridge,
  jinaUrl: string,
  budgetSec: number,
): Promise<CaptureResponse> {
  const cap = new CaptureResponse();
  const originalReqUrl = ctx.req.url;
  const origXTimeout = ctx.req.headers['x-timeout'];
  // 改写 req.url 为 jina 视角的 URL(含 query),透传 clamp-180 的 x-timeout
  ctx.req.url = jinaUrl;
  ctx.req.headers['x-timeout'] = String(Math.min(budgetSec, JINA_TIMEOUT_CAP));
  const restore = (): void => {
    ctx.req.url = originalReqUrl;
    if (origXTimeout === undefined) delete ctx.req.headers['x-timeout'];
    else ctx.req.headers['x-timeout'] = origXTimeout;
  };

  let timer: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      restore();
      reject(new ReadTimeoutError(budgetSec));
    }, budgetSec * 1000);
  });
  try {
    jina.handler(ctx.req, cap as unknown as Parameters<JinaReaderBridge['handler']>[1]);
    await Promise.race([cap.settledPromise, timeoutP]);
  } finally {
    clearTimeout(timer!);
    restore();
  }
  return cap;
}

/** 捕获 jina 响应的最小 ServerResponse 实现:收集 statusCode/headers/body,settled 时 resolve */
class CaptureResponse {
  statusCode = 200;
  statusMessage = '';
  headers: Record<string, string | string[]> = {};
  private chunks: Buffer[] = [];
  private ended = false;
  private finishResolve?: () => void;
  /** jina 结束(调用 end)后 resolve;超时由 jinaFetch 侧兜底 */
  readonly settledPromise: Promise<void>;

  constructor() {
    this.settledPromise = new Promise((resolve) => {
      this.finishResolve = resolve;
    });
  }

  // ---- ServerResponse 常用接口(jina koa respond 会用) ----
  setHeader(name: string, value: string | string[]): void {
    this.headers[name] = value;
  }
  getHeader(name: string): string | string[] | undefined {
    return this.headers[name];
  }
  getHeaders(): Record<string, string | string[]> {
    return this.headers;
  }
  hasHeader(name: string): boolean {
    return name in this.headers;
  }
  getHeaderNames(): string[] {
    return Object.keys(this.headers);
  }
  removeHeader(name: string): void {
    delete this.headers[name];
  }
  writeHead(statusCode: number, reasonOrHeaders?: string | Record<string, string | string[]>, headers?: Record<string, string | string[]>): this {
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
    else if (reasonOrHeaders) headers = reasonOrHeaders;
    this.statusCode = statusCode;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  flushHeaders(): void {
    // 捕获模式无需真正 flush
  }
  write(chunk: string | Buffer): boolean {
    if (this.ended) return false;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    if (!this.ended) {
      this.ended = true;
      this.finishResolve?.();
    }
    return this;
  }
  // ---- 事件 stub(jina 侧可能 on/once 监听,捕获模式忽略) ----
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
  get finished(): boolean {
    return this.ended;
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** jina 返回非 200:捕获响应透传给客户端,不写缓存 */
class JinaNonOkError extends Error {
  constructor(readonly cap: CaptureResponse) {
    super(`jina 返回 ${cap.statusCode}`);
    this.name = 'JinaNonOkError';
  }
}

/** read 整体硬超时(HTTP 层,504) */
class ReadTimeoutError extends Error {
  constructor(readonly budgetSec: number) {
    super(`read 超时(整体预算 ${budgetSec}s)`);
    this.name = 'ReadTimeoutError';
  }
}

// ---- search ----

interface SearchRoute {
  type: 'ai' | 'web';
  /** GET 时路径内携带的 query(原始编码);POST 时为空 */
  pathQuery: string;
}

function parseSearchRoute(p: string): SearchRoute | null {
  if (p === '/s') return { type: 'ai', pathQuery: '' };
  if (p.startsWith('/s/')) return { type: 'ai', pathQuery: p.slice('/s/'.length) };
  if (p === '/search/ai') return { type: 'ai', pathQuery: '' };
  if (p.startsWith('/search/ai/')) return { type: 'ai', pathQuery: p.slice('/search/ai/'.length) };
  if (p === '/search/web') return { type: 'web', pathQuery: '' };
  if (p.startsWith('/search/web/')) return { type: 'web', pathQuery: p.slice('/search/web/'.length) };
  return null;
}

async function handleSearch(
  ctx: Koa.Context,
  bocha: BochaClient,
  type: 'ai' | 'web',
  pathQuery: string,
): Promise<void> {
  let query: string;
  let params: Record<string, unknown>;
  if (ctx.method === 'GET') {
    query = decodePathQuery(pathQuery);
    params = ctx.query as Record<string, unknown>;
  } else if (ctx.method === 'POST') {
    const body = ((ctx.request as any).body ?? {}) as Record<string, unknown>;
    query = String(body.query ?? '');
    params = body;
  } else {
    ctx.status = 405;
    ctx.body = { error: 'Method Not Allowed' };
    return;
  }

  if (!query || !query.trim()) {
    ctx.status = 400;
    ctx.body = { error: '缺少 query 参数' };
    return;
  }
  if (!bocha.isConfigured) {
    ctx.status = 500;
    ctx.body = { error: 'BOCHA_API_KEY 未配置,无法搜索' };
    return;
  }

  if (type === 'web') {
    const pages = await bocha.webSearch(query, {
      count: parseCount(params.count),
      freshness: strOrNull(params.freshness),
      summary: parseBool(params.summary),
      include: strOrNull(params.include),
      exclude: strOrNull(params.exclude),
    });
    ctx.body = { webPages: pages };
  } else {
    const result = await bocha.aiSearch(query, {
      count: parseCount(params.count),
      freshness: strOrNull(params.freshness),
      answer: parseBool(params.answer),
      include: strOrNull(params.include),
    });
    ctx.body = {
      summary: result.summary,
      webPages: result.pages,
      modalCards: result.modalCards,
      followUpQuestions: result.followUpQuestions,
    };
  }
}

/** 路径内 query/url 解码(koa path 若已解码则原样返回) */
function decodePathQuery(s: string): string {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- 参数辅助 ----

function parseCount(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(v: unknown): boolean | undefined {
  if (v == null || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

function strOrNull(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}
