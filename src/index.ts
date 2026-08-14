import { loadConfig } from './config';
import { createJinaReaderBridge } from './jina/reader';
import { createApp } from './server';

/**
 * 入口:加载配置 → 初始化 jina 桥接 → 组装整合服务器 → 监听单一端口。
 * 容器内通过 Dockerfile CMD 启动此入口,覆盖 jina 默认服务(ADR-0001)。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const jina = await createJinaReaderBridge(config);
  const app = await createApp({ config, jina });
  const server = app.listen(config.port, config.host);
  console.log(`[search-reader-mcp] listening on http://${config.host}:${config.port}`);

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[search-reader-mcp] 启动失败:', e);
  process.exit(1);
});
