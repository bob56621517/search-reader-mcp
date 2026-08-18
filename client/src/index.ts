import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * v0.3 client(本地 stdio MCP)骨架 — T1(票据 01)只建立项目骨架与 stdio 入口。
 * search/read 工具(desc/hints 来自 /catalog)、本地文件读取、容器生命周期(ADR-0011)
 * 在票据 02(T2)实现;届时本文件替换为完整启动流程。
 */
const server = new McpServer({ name: 'search-reader-mcp-client', version: '0.3.0' });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[search-reader-mcp-client] stdio ready');
}

main().catch((e) => {
  console.error('[search-reader-mcp-client] 启动失败:', e);
  process.exit(1);
});
