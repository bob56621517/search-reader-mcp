import { AiSearchResult, ModalCard, WebPage } from './types';

/**
 * 博查能力层客户端(独立实现,ADR-0002)。
 * 语义照搬参考实现 xyz-mcp-hub 的 io.xyz.xyz_mcp_hub.bocha.BochaClient:
 *  - 两个端点 /v1/web-search 与 /v1/ai-search,HTTP 客户端用内置 fetch
 *  - 参数透传(query 必填、count 钳制 1..50、freshness 校验、布尔透传、include/exclude)
 *  - 返回结构化 VO,不格式化文本(默认值预设与格式化交给工具层)
 */

const MAX_COUNT = 50;
const FRESHNESS_VALUES = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'];
const FRESHNESS_DATE_RANGE = /^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/;

/** web-search 的可选参数 */
export interface WebSearchOptions {
  count?: number | null;
  freshness?: string | null;
  summary?: boolean | null;
  include?: string | null;
  exclude?: string | null;
}

/** ai-search 的可选参数(AI 无 exclude,官网缺口) */
export interface AiSearchOptions {
  count?: number | null;
  freshness?: string | null;
  answer?: boolean | null;
  include?: string | null;
}

export interface BochaClientOptions {
  apiKey: string;
  baseUrl: string;
}

export class BochaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: BochaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  /** 是否已配置 API 密钥(未配置时 search 能力应明确报错) */
  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** 网页搜索(web-search) */
  async webSearch(query: string, options: WebSearchOptions = {}): Promise<WebPage[]> {
    const body = this.requestBody(query, options.count, options.freshness);
    if (options.summary != null) body.summary = options.summary;
    this.putIfPresent(body, 'include', options.include);
    this.putIfPresent(body, 'exclude', options.exclude);
    const root = await this.call('/v1/web-search', body);
    return this.parsePages(root?.data?.webPages?.value);
  }

  /** AI 搜索(ai-search) */
  async aiSearch(query: string, options: AiSearchOptions = {}): Promise<AiSearchResult> {
    const body = this.requestBody(query, options.count, options.freshness);
    if (options.answer != null) body.answer = options.answer;
    this.putIfPresent(body, 'include', options.include);
    const root = await this.call('/v1/ai-search', body);
    return this.parseAiResult(root);
  }

  // ---- 请求 ----

  private requestBody(
    query: string,
    count?: number | null,
    freshness?: string | null,
  ): Record<string, unknown> {
    if (!query || !query.trim()) {
      throw new Error('请提供搜索关键词 query。');
    }
    const body: Record<string, unknown> = { query };
    if (count != null) {
      body.count = Math.max(1, Math.min(Math.round(count), MAX_COUNT));
    }
    const fresh = this.normalizeFreshness(freshness);
    if (fresh != null) body.freshness = fresh;
    return body;
  }

  /** freshness:枚举原样透传;日期范围透传;空不传;未知值回退 noLimit */
  private normalizeFreshness(freshness?: string | null): string | null {
    if (!freshness || !freshness.trim()) return null;
    if (FRESHNESS_VALUES.includes(freshness) || FRESHNESS_DATE_RANGE.test(freshness)) {
      return freshness;
    }
    return 'noLimit';
  }

  /** 非空字符串才写入请求体(include/exclude 等) */
  private putIfPresent(body: Record<string, unknown>, key: string, value?: string | null): void {
    if (value && value.trim()) body[key] = value;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`博查请求失败:${(e as Error).message}`);
    }
    const text = await res.text();
    let root: any;
    try {
      root = JSON.parse(text);
    } catch {
      throw new Error(`博查搜索失败:无法解析响应\n${text}`);
    }
    const code = typeof root?.code === 'number' ? root.code : -1;
    if (code !== 200) {
      const msg = root?.msg || root?.message || '';
      throw new Error(`博查搜索失败(code=${code}):${msg}`);
    }
    return root;
  }

  // ---- 响应解析 ----

  private parsePages(pages: any): WebPage[] {
    if (!Array.isArray(pages)) return [];
    return pages.map((p: any) => ({
      name: String(p?.name ?? ''),
      url: String(p?.url ?? ''),
      siteName: String(p?.siteName ?? ''),
      snippet: String(p?.snippet ?? ''),
      summary: String(p?.summary ?? ''),
    }));
  }

  /** ai-search 响应:顶层 messages[];answer/source/follow_up 按语义归集 */
  private parseAiResult(root: any): AiSearchResult {
    let summary: string | null = null;
    const pages: WebPage[] = [];
    const modalCards: ModalCard[] = [];
    const followUpQuestions: string[] = [];

    const messages = root?.messages;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        const type = String(message?.type ?? '');
        const contentType = String(message?.content_type ?? '');
        const content = String(message?.content ?? '');
        if (type === 'answer' && summary == null && content.trim()) {
          summary = content;
        } else if (type === 'source' && content.trim()) {
          if (contentType === 'webpage') {
            const inner = this.readJson(content);
            pages.push(...this.parsePages(inner?.value));
          } else {
            this.parseModalCards(contentType, content, modalCards);
          }
        } else if (type === 'follow_up' && content.trim()) {
          const qs = this.readJson(content);
          if (Array.isArray(qs)) {
            for (const q of qs) {
              const t = typeof q === 'string' ? q : JSON.stringify(q);
              if (t.trim()) followUpQuestions.push(t);
            }
          }
        }
      }
    }
    return { summary, pages, modalCards, followUpQuestions };
  }

  private readJson(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /** 模态卡:content 为 JSON 数组字符串,数组项含 modelCard,结构化 JSON 原样保留 */
  private parseModalCards(contentType: string, content: string, out: ModalCard[]): void {
    const arr = this.readJson(content);
    const items = Array.isArray(arr) ? arr : (arr?.value ?? []);
    for (const item of items) {
      const card = item?.modelCard;
      if (card != null && typeof card === 'object') {
        out.push({ contentType, modelCardJson: JSON.stringify(card) });
      }
    }
  }
}
