import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveToolMetadata } from './catalog';
import { loadClientConfig } from './config';
import { RealDockerExecutor } from './docker';
import { createLifecycle } from './lifecycle';
import { RealServerHttp } from './server-http';
import { createMcpServer } from './tools';

/**
 * v0.3 client 本地 stdio MCP 入口(ADR-0008/0011)。
 * 启动流程:health 探测命中 → 复用;否则 docker 可用 + REQUIRED_ENVS 齐备 → 后台
 * docker run(常驻);缺前置 → stderr 报错并按正常 MCP 失败路径退出(工具不注册)。
 * 工具 desc/hints 启动时从 /catalog 拉取(ADR-0009),失败回退本地内建默认。
 */
async function main(): Promise<void> {
  const config = loadClientConfig();
  const http = new RealServerHttp(config);
  const docker = new RealDockerExecutor(config);
  const lifecycle = createLifecycle(config, http, docker);

  // 生命周期:缺前置(无 docker / 缺必填 env / docker run 失败)→ 报错退出,工具不注册
  const started = await lifecycle.ensureStarted();
  if (!started.ok) {
    console.error(`[search-reader-mcp-client] 启动失败:${started.reason}`);
    process.exit(1);
  }

  // 工具 desc/hints 单一来源是 server(/catalog);starting 窗口期拉取失败回退本地默认
  const metadata = await resolveToolMetadata(http);
  const server = createMcpServer({ config, http, lifecycle, metadata });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[search-reader-mcp-client] stdio ready(server=${config.serverUrl}, status=${lifecycle.status()})`,
  );
}

main().catch((e) => {
  console.error('[search-reader-mcp-client] 启动失败:', e);
  process.exit(1);
});
