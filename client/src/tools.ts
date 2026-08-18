import { promises as fs } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolMetadata } from './catalog';
import type { ClientConfig } from './config';
import { DEFAULT_READ_DESC, DEFAULT_SEARCH_DESC } from './desc';
import { formatAiSearch, formatWebSearch } from './format';
import type { Lifecycle } from './lifecycle';
import { classifyUri, renderUnsupportedPathText, toAbsolutePath } from './local-file';
import { buildReadSchema, buildSearchSchema } from './schema';
import type { ServerHttp } from './server-http';
import { DEFAULT_READ_LENGTH, sliceText } from './slice';

/**
 * client MCP 工具层(search/read)。向 Agent 暴露两工具:
 *  - search:镜像整合服务器参数,POST /search/<type>(统一走 POST)
 *  - read:http(s) → POST /read/<url>;本地文件绝对路径 → 读取后 multipart POST /read
 *    上传解析;相对路径 → 指令文本不解析(ADR-0010);skip/length 本地切片。
 * 容器生命周期状态(ADR-0011):starting → 返回"正在启动";ready 后调用失败 → 返回
 * "容器未运行"指令文本(ADR-0007),不自动重启。
 */

/** 窗口期状态文本:容器首次拉取镜像较慢,不阻塞、可自助加速 */
export function renderStartingText(config: ClientConfig): string {
  return (
    `本地整合服务器容器正在启动(首次拉取镜像可能较慢),当前不可用。` +
    `可手动加速镜像拉取:\n  docker pull ${config.image}\n` +
    `容器就绪后工具调用将自动恢复。`
  );
}

/** 运行时容器挂掉 → 指令文本(ADR-0007:报错即 prompt),不自动重启(ADR-0011) */
export function renderContainerDownText(config: ClientConfig): string {
  return (
    `本地整合服务器容器未运行(服务不可达)。容器为常驻基础设施(--restart unless-stopped),` +
    `退出 client 不会停止它。请手动恢复:\n  docker start ${config.containerName}\n` +
    `或重新创建:\n  docker run -d --name ${config.containerName} --restart unless-stopped ` +
    `-p ${config.hostPort}:18081 -e BOCHA_API_KEY -v ${config.dataVolume}:/app/extension/data ${config.image}`
  );
}

export interface McpToolDeps {
  config: ClientConfig;
  http: ServerHttp;
  lifecycle: Lifecycle;
  metadata: ToolMetadata;
}

export function createMcpServer(deps: McpToolDeps): McpServer {
  const { config, http, lifecycle, metadata } = deps;
  const server = new McpServer({ name: 'search-reader-mcp-client', version: '0.3.0' });

  server.tool(
    'search',
    metadata.search.description,
    buildSearchSchema(DEFAULT_SEARCH_DESC),
    { title: '联网搜索(博查)', ...metadata.search.annotations },
    async ({ type, query, count, freshness, include, exclude }) => {
      if (lifecycle.status() === 'starting') {
        return textResult(renderStartingText(config));
      }
      const t = type ?? 'ai';
      const n = Math.max(1, Math.min(50, count ?? 20));
      const fresh = freshness || 'noLimit';
      try {
        // 恒传 summary(web)/answer(ai),对齐 server MCP search 工具行为(server HTTP 层仅在显式传入时透传)
        const json = await http.search(t, {
          query,
          count: n,
          freshness: fresh,
          include,
          exclude,
          ...(t === 'web' ? { summary: true } : { answer: true }),
        });
        return textResult(t === 'web' ? formatWebSearch(json) : formatAiSearch(json));
      } catch (e) {
        // 运行时容器挂掉 → 返回"容器未运行"指令文本;否则返回可读错误
        if (lifecycle.status() !== 'ready') {
          return textResult(renderContainerDownText(config));
        }
        return textResult(`搜索失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'read',
    metadata.read.description,
    buildReadSchema(DEFAULT_READ_DESC),
    { title: '读取网页或本地文件(jina)', ...metadata.read.annotations },
    async ({ uri, skip, length, engine, timeout }) => {
      // scheme/路径分流(ADR-0010):相对路径/无法识别 → 指令文本,不解析
      const kind = classifyUri(uri);
      if (kind !== 'http' && kind !== 'file') {
        return textResult(renderUnsupportedPathText(uri, kind));
      }
      if (lifecycle.status() === 'starting') {
        return textResult(renderStartingText(config));
      }
      const opts = { engine, timeout };
      try {
        let full: string;
        if (kind === 'http') {
          full = await http.readUrl(uri, opts);
        } else {
          const absPath = toAbsolutePath(uri);
          const buf = await fs.readFile(absPath);
          full = await http.uploadFile(absPath, buf, opts);
        }
        return textResult(sliceText(full, skip ?? 0, length ?? DEFAULT_READ_LENGTH));
      } catch (e) {
        if (lifecycle.status() !== 'ready') {
          return textResult(renderContainerDownText(config));
        }
        // 本地文件读取失败(不存在/无权限)或代理失败 → 可读错误
        return textResult(`读取失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return server;
}

/** 将文本包成 MCP 工具返回的 content 结构(SDK 要求) */
function textResult(text: string): {
  content: [{ type: 'text'; text: string }];
} {
  return { content: [{ type: 'text', text }] };
}
