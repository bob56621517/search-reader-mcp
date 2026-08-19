import * as path from 'node:path';
import type { ClientConfig } from './config';

/**
 * client → server 的 HTTP 边界(ADR-0008:两项目唯一共享面)。
 * 全部走 POST(jina 契约 GET|POST 等价,选项可入 body),统一经注入的 fetch 调用,
 * 测试在此边界注入假实现,不触真实 server。
 *
 * 路由契约对齐 server/src/server.ts:
 *   health      GET  /health                                  → 200 即容器可用
 *   catalog     GET  /catalog                                 → {tools:[{name,description,annotations}]}
 *   readUrl     POST /read/<url>  header X-Engine/X-Read-Timeout → Markdown 全文
 *   uploadFile  POST /read        multipart file=<buf>        → Markdown 全文(不缓存)
 *   search      POST /search/<type> body {query,...}          → 结构化 JSON
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CatalogTool {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
}
export interface Catalog {
  tools: CatalogTool[];
}

export interface SearchParams {
  query: string;
  count?: number;
  freshness?: string;
  include?: string;
  exclude?: string;
  /** web 恒 true(对齐 server MCP webSearch 的 summary),经 server HTTP 透传 bocha */
  summary?: boolean;
  /** ai 恒 true(对齐 server MCP aiSearch 的 answer),经 server HTTP 透传 bocha */
  answer?: boolean;
}

export interface ReadUrlOptions {
  engine?: string;
  timeout?: number;
}

export interface ServerHttp {
  /** 健康探测:HTTP 200 即 true(超时/拒绝连接均 false) */
  health(): Promise<boolean>;
  catalog(): Promise<Catalog>;
  /** 代理 http(s) URL 抓取,返回 Markdown 全文 */
  readUrl(url: string, opts?: ReadUrlOptions): Promise<string>;
  /** 上传本地文件解析,返回 Markdown 全文 */
  uploadFile(filePath: string, data: Buffer, opts?: ReadUrlOptions): Promise<string>;
  /** 代理搜索,返回结构化 JSON(调用方自行格式化) */
  search(type: 'ai' | 'web', params: SearchParams): Promise<Record<string, unknown>>;
}

/** engine → jina 透传 header 值(direct→curl、browser→browser、auto/缺省→不传);与 server 契约对齐 */
function engineHeaderValue(engine: string | undefined): string | undefined {
  if (engine === 'direct') return 'curl';
  if (engine === 'browser') return 'browser';
  return undefined;
}

/** 常见扩展名 → MIME(对齐 curl -F 行为;jina 上传解析按扩展名嗅探,MIME 主要影响 Content-Disposition) */
function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

export class RealServerHttp implements ServerHttp {
  constructor(
    private readonly config: ClientConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.config.serverUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.healthProbeTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async catalog(): Promise<Catalog> {
    const res = await this.fetchImpl(`${this.config.serverUrl}/catalog`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.config.catalogTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`GET /catalog 失败:HTTP ${res.status}`);
    }
    return (await res.json()) as Catalog;
  }

  async readUrl(url: string, opts: ReadUrlOptions = {}): Promise<string> {
    // 选项经 header(X-Engine / X-Read-Timeout)传递,与 server 内 readUrl(self-call)一致;
    // 不发 JSON body:POST /read/<url> 由 server 跳过 bodyParser,body 会致 jina 内层
    // 499 "Request already closed"(真实 jina 实测)。
    const headers: Record<string, string> = {};
    const eng = engineHeaderValue(opts.engine);
    if (eng) headers['X-Engine'] = eng;
    if (opts.timeout !== undefined) headers['X-Read-Timeout'] = String(opts.timeout);
    const res = await this.fetchImpl(`${this.config.serverUrl}/read/${encodeURIComponent(url)}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.readTimeoutMs(opts)),
    });
    if (!res.ok) {
      throw new Error(`读取失败:HTTP ${res.status}`);
    }
    return res.text();
  }

  async uploadFile(filePath: string, data: Buffer, opts: ReadUrlOptions = {}): Promise<string> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(data)], { type: mimeFor(filePath) });
    form.append('file', blob, path.basename(filePath));
    const headers: Record<string, string> = {};
    const eng = engineHeaderValue(opts.engine);
    if (eng) headers['X-Engine'] = eng;
    if (opts.timeout !== undefined) headers['X-Read-Timeout'] = String(opts.timeout);
    const res = await this.fetchImpl(`${this.config.serverUrl}/read`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(this.readTimeoutMs(opts)),
    });
    if (!res.ok) {
      throw new Error(`文件上传解析失败:HTTP ${res.status}`);
    }
    return res.text();
  }

  async search(type: 'ai' | 'web', params: SearchParams): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { query: params.query };
    if (params.count !== undefined) body.count = params.count;
    if (params.freshness !== undefined) body.freshness = params.freshness;
    if (params.include !== undefined) body.include = params.include;
    if (params.exclude !== undefined) body.exclude = params.exclude;
    if (params.summary !== undefined) body.summary = params.summary;
    if (params.answer !== undefined) body.answer = params.answer;
    const res = await this.fetchImpl(`${this.config.serverUrl}/search/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`搜索失败:HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** read fetch 等待超时:per-call timeout(秒)优先,缺省 httpTimeoutMs(否则 schema 允许的 ≤600s 会被 120s 默认截断) */
  private readTimeoutMs(opts: ReadUrlOptions): number {
    return opts.timeout !== undefined ? opts.timeout * 1000 : this.config.httpTimeoutMs;
  }
}
