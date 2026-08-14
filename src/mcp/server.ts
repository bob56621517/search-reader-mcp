import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BochaClient } from '../bocha/client';
import { AiSearchResult, WebPage } from '../bocha/types';

/**
 * MCP 服务层(官方 SDK)。暴露两个工具:
 *  - search:type 默认 ai(web/ai 合一),工具层预设默认值并格式化
 *  - read:url(http/https),复用本服务 read/ 路由
 */

export interface McpToolDeps {
  bocha: BochaClient;
  readUrl(url: string): Promise<string>;
}

export function createMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: 'search-reader-mcp', version: '0.1.0' });

  server.tool(
    'search',
    '博查(bocha)搜索 MCP 工具。type 缺省为 ai(AI 语义搜索):除网页来源外还返回大模型总结答案、追问问题与垂域模态卡,适合事实问答/综述;需要排除特定网站或只要裸网页列表时显式 type="web"。返回的网页来源请在回答末尾把 URL 渲染为超链接附上,便于用户溯源。',
    {
      type: z
        .enum(['ai', 'web'])
        .optional()
        .describe('搜索类型:ai(默认,AI 语义搜索,含总结/追问/模态卡)或 web(网页长摘要列表,支持 exclude)'),
      query: z.string().describe('搜索关键词'),
      count: z.number().int().optional().describe('返回条数上限,默认 20,最大 50(越界自动钳制)'),
      freshness: z
        .string()
        .optional()
        .describe('时效:noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear,或 YYYY-MM-DD..YYYY-MM-DD 日期范围'),
      include: z.string().optional().describe('限定网站范围:根域名或子域名,多个用 | 或 , 分隔,最多 100 个;web/ai 均支持'),
      exclude: z.string().optional().describe('排除网站范围:同上;仅 type="web" 生效'),
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
