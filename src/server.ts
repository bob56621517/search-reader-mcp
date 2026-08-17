import bodyParser from '@koa/bodyparser';
import Koa from 'koa';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { BochaClient } from './bocha/client';
import { CacheDb } from './cache/sqlite';
import { Config } from './config';
import { JinaReaderBridge } from './jina/reader';
import { DailyLogger } from './log/daily';
import { createMcpServer } from './mcp/server';

/**
 * 整合服务器(ADR-0001):单端口承载 read/、search/、mcp/、sse/。
 * createApp 只组装 koa app 不 listen,便于测试(supertest)与启动(index)共用。
 *
 * 路由形态:
 *   read   GET /read/<url> | /r/<url>           路径即 url
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

export async function createApp(deps: AppDeps): Promise<Koa> {
  const config = deps.config;
  // sqlite 缓存基础设施:先建库,暂不接入缓存(roadmap #3)
  CacheDb.open(config.sqlitePath);
  const logger = new DailyLogger(config.logDir);
  const bocha = new BochaClient({ apiKey: config.bocha.apiKey, baseUrl: config.bocha.baseUrl });
  const jina = deps.jina ?? null;

  // readUrl:供 MCP read 工具复用本服务 read/ 路由(self-call,路径即 url)
  const readUrl = async (url: string): Promise<string> => {
    if (!jina) return READ_UNAVAILABLE;
    const res = await fetch(`http://127.0.0.1:${config.port}/r/${encodeURIComponent(url)}`);
    return res.text();
  };

  // MCP server 工厂:每传输/每会话独立实例,避免单 Server 多 connect 互相覆盖(SDK 单传输语义)
  const makeMcp = () => createMcpServer({ bocha, readUrl, searchDesc: config.mcpDesc.search });

  // mcp/ 走 streamable HTTP(独立实例);有状态会话,sessionId 由服务端生成
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await makeMcp().connect(mcpTransport);

  // sse/ 为 legacy SSE:每个 GET /sse 建立独立 server + 传输
  const sseSessions = new Map<string, SSEServerTransport>();

  const app = new Koa();
  app.use(bodyParser());
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
        await mcpTransport.handleRequest(ctx.req, ctx.res, (ctx.request as any).body);
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
      // ---- read:路径即 url ----
      if (p === '/r' || p.startsWith('/r/') || p === '/read' || p.startsWith('/read/')) {
        await handleRead(ctx, jina);
        return;
      }
      // ---- search ----
      const route = parseSearchRoute(p);
      if (route) {
        await handleSearch(ctx, bocha, route.type, route.pathQuery);
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

// ---- read 路由:路径即 url(/r/<url>),改写 req.url 后交给 jina koaApp ----

async function handleRead(ctx: Koa.Context, jina: JinaReaderBridge | null): Promise<void> {
  const p = ctx.path;
  const prefix = p.startsWith('/read') ? '/read' : '/r';
  // 路径剩余即目标 URL(可能带前导 / 或已编码),去前导斜杠后作为干净 URL
  const target = decodePathQuery(p.slice(prefix.length)).replace(/^\/+/, '');
  if (!target) {
    ctx.status = 400;
    ctx.body = { error: '缺少 url' };
    return;
  }
  if (!jina) {
    ctx.status = 503;
    ctx.body = { error: READ_UNAVAILABLE };
    return;
  }
  // 传给 jina koaApp 时改写 req.url 为 /<url>,复用其原生"路径即 URL"语义
  ctx.respond = false;
  const originalReqUrl = ctx.req.url;
  ctx.req.url = '/' + target;
  jina.handler(ctx.req, ctx.res);
  ctx.req.url = originalReqUrl;
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
