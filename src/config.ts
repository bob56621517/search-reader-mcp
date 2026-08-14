import * as path from 'node:path';

/**
 * 环境变量配置。
 * 默认值集中定义在 docker-compose.yml,用户按需手工修改。
 */
export interface Config {
  /** 监听端口(容器内外一致,默认 18081) */
  port: number;
  host: string;
  /** jina 镜像应用根目录(默认 /app) */
  jinaApp: string;
  bocha: {
    /** bocha API 密钥,标准环境变量 BOCHA_API_KEY(开发/compose 共用) */
    apiKey: string;
    /** bocha base-url,默认 https://api.bochaai.com */
    baseUrl: string;
  };
  /** 持久化数据目录(compose 外挂宿主 ~/.search_reader_mcp) */
  dataDir: string;
  /** sqlite 库文件路径 */
  sqlitePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.SEARCH_READER_MCP_DATA || '/app/extension/data';
  return {
    port: parseInt(env.PORT || '18081', 10),
    host: env.HOST || '0.0.0.0',
    jinaApp: env.JINA_APP || '/app',
    bocha: {
      apiKey: env.BOCHA_API_KEY || '',
      baseUrl: env.BOCHA_URL || 'https://api.bochaai.com',
    },
    dataDir,
    sqlitePath: env.SQLITE_PATH || path.join(dataDir, 'cache.db'),
  };
}
