import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BochaClient } from '../bocha/client';
import { AiSearchResult, WebPage } from '../bocha/types';
import type { McpDesc } from '../config';

/**
 * MCP 服务层(官方 SDK)。暴露两个工具:
 *  - search:type 默认 ai(web/ai 合一),工具层预设默认值并格式化
 *  - read:url(http/https),复用本服务 read/ 路由
 */

export interface McpToolDeps {
  bocha: BochaClient;
  readUrl(url: string): Promise<string>;
  /** search 工具/参数描述(经 config.mcpDesc 注入,env 可覆盖,缺省内建) */
  searchDesc: McpDesc['search'];
}

export function createMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: 'search-reader-mcp', version: '0.1.0' });

  const { searchDesc } = deps;
  server.tool(
    'search',
    searchDesc.description,
    {
      type: z.enum(['ai', 'web']).optional().describe(searchDesc.type),
      query: z.string().describe(searchDesc.query),
      count: z.number().int().optional().describe(searchDesc.count),
      freshness: z.string().optional().describe(searchDesc.freshness),
      include: z.string().optional().describe(searchDesc.include),
      exclude: z.string().optional().describe(searchDesc.exclude),
    },
    async ({ type, query, count, freshness, include, exclude }) => {
      const n = Math.max(1, Math.min(50, count ?? 20));
      const fresh = freshness || 'noLimit';
      try {
        if (type === 'web') {
          return textResult(formatWeb(await deps.bocha.webSearch(query, { count: n, freshness: fresh, summary: true, include, exclude })));
        }
        // 默认 ai;AI 无 exclude 参数(官网缺口),忽略
        return textResult(formatAi(await deps.bocha.aiSearch(query, { count: n, freshness: fresh, answer: true, include })));
      } catch (e) {
        return textResult((e as Error).message);
      }
    },
  );

  server.tool(
    'read',
    '将网页或 PDF(URL)转换为 Markdown 正文返回。例:url=https://example.com 返回该网页的 Markdown 正文。',
    { url: z.string().describe('要读取的网页/PDF 地址(http/https)') },
    async ({ url }) => textResult(await deps.readUrl(url)),
  );

  return server;
}

/** 将文本包成 MCP 工具返回的 content 结构(SDK 要求) */
function textResult(text: string): {
  content: [{ type: 'text'; text: string }];
} {
  return { content: [{ type: 'text', text }] };
}

// ---- VO → 模型友好文本(对齐参考实现 BochaTools) ----

function formatWeb(pages: WebPage[]): string {
  const sb: string[] = [];
  appendPages(sb, pages);
  return sb.length ? sb.join('\n').trimEnd() : '未找到相关结果。';
}

function formatAi(result: AiSearchResult): string {
  const sb: string[] = [];
  if (result.summary && result.summary.trim()) {
    sb.push(`AI 总结:${result.summary}`);
  }
  for (const card of result.modalCards) {
    sb.push(`模态卡 · ${card.contentType}:\n${card.modelCardJson}`);
  }
  appendPages(sb, result.pages);
  if (result.followUpQuestions.length) {
    sb.push('追问问题:');
    result.followUpQuestions.forEach((q, i) => sb.push(`${i + 1}. ${q}`));
  }
  return sb.length ? sb.join('\n').trimEnd() : '未找到相关结果。';
}

function appendPages(sb: string[], pages: WebPage[]): void {
  if (!pages || !pages.length) return;
  pages.forEach((p, i) => {
    let line = `${i + 1}. `;
    if (p.name) line += p.name;
    if (p.url) line += `(${p.url})`;
    if (p.siteName) line += ` [${p.siteName}]`;
    sb.push(line);
    if (p.snippet) sb.push(`   ${p.snippet}`);
  });
}
