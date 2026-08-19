/**
 * search 结果 → 模型友好文本(client 自持,与 server mcp/server.ts 的 formatWeb/formatAi 契约一致)。
 * client 的 search 镜像整合服务器参数、行为一致;HTTP /search/<type> 返回结构化 JSON,
 * 此处格式化为 agent 可读文本。
 */

interface WebPage {
  name?: string;
  url?: string;
  siteName?: string;
  snippet?: string;
}

interface ModalCard {
  contentType?: string;
  modelCardJson?: string;
}

/** 取 HTTP JSON 中的网页列表(web 与 ai 均以 webPages 字段承载) */
function pagesOf(json: Record<string, unknown>): WebPage[] {
  const list = json.webPages;
  return Array.isArray(list) ? (list as WebPage[]) : [];
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

export function formatWebSearch(json: Record<string, unknown>): string {
  const sb: string[] = [];
  appendPages(sb, pagesOf(json));
  return sb.length ? sb.join('\n').trimEnd() : '未找到相关结果。';
}

export function formatAiSearch(json: Record<string, unknown>): string {
  const sb: string[] = [];
  if (typeof json.summary === 'string' && json.summary.trim()) {
    sb.push(`AI 总结:${json.summary}`);
  }
  const cards = Array.isArray(json.modalCards) ? (json.modalCards as ModalCard[]) : [];
  for (const card of cards) {
    if (card.contentType || card.modelCardJson) {
      sb.push(`模态卡 · ${card.contentType ?? ''}:\n${card.modelCardJson ?? ''}`);
    }
  }
  appendPages(sb, pagesOf(json));
  const questions = Array.isArray(json.followUpQuestions) ? (json.followUpQuestions as string[]) : [];
  if (questions.length) {
    sb.push('追问问题:');
    questions.forEach((q, i) => sb.push(`${i + 1}. ${q}`));
  }
  return sb.length ? sb.join('\n').trimEnd() : '未找到相关结果。';
}
