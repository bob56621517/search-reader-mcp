import * as os from 'node:os';
import * as path from 'node:path';

/**
 * client(本地 stdio MCP)运行时配置(ADR-0008/0011)。
 * 与 server 项目独立依赖,此处只定义 client 自身需要的配置;
 * server 地址/镜像/容器名等生命周期参数集中于此,env 可覆盖。
 */

export interface ClientConfig {
  /** 整合服务器地址(本地 docker 映射端口),默认 http://localhost:18081 */
  serverUrl: string;
  /** docker 可执行文件,默认 'docker'(测试可指向假脚本) */
  dockerBin: string;
  /** 容器名,默认 'search-reader-mcp'(docker run --name) */
  containerName: string;
  /** GHCR 镜像,默认 ghcr.io/bob56621517/search-reader-mcp:v0.3.0 */
  image: string;
  /** 宿主机端口(映射容器内 18081),默认 18081 */
  hostPort: number;
  /** 宿主数据卷绝对路径(docker run -v),默认 ~/.search_reader_mcp */
  dataVolume: string;
  /** 必填环境变量列表(缺任一即拒绝启动,ADR-0011);当前仅 BOCHA_API_KEY */
  requiredEnvs: string[];
  /** 健康探测超时(ms) */
  healthProbeTimeoutMs: number;
  /** 后台轮询 /health 间隔(ms) */
  healthPollIntervalMs: number;
  /** docker run 判定超时(ms):超过视为正在拉取镜像,转为后台观察 */
  dockerRunTimeoutMs: number;
  /** 启动窗口(ms):starting 后超过仍未健康,视为容器不可用(down) */
  startupWindowMs: number;
  /** /catalog 拉取超时(ms) */
  catalogTimeoutMs: number;
  /** 代理 read/search 的 HTTP 调用超时(ms) */
  httpTimeoutMs: number;
}

function envStr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  return {
    serverUrl: envStr(env, 'SERVER_URL', 'http://localhost:18081'),
    dockerBin: envStr(env, 'SEARCH_READER_MCP_DOCKER', 'docker'),
    containerName: envStr(env, 'SEARCH_READER_MCP_CONTAINER', 'search-reader-mcp'),
    image: envStr(env, 'SEARCH_READER_MCP_IMAGE', 'ghcr.io/bob56621517/search-reader-mcp:v0.3.0'),
    hostPort: envInt(env, 'SEARCH_READER_MCP_PORT', 18081),
    dataVolume: envStr(
      env,
      'SEARCH_READER_MCP_DATA',
      path.join(os.homedir(), '.search_reader_mcp'),
    ),
    requiredEnvs: ['BOCHA_API_KEY'],
    healthProbeTimeoutMs: envInt(env, 'SEARCH_READER_MCP_HEALTH_TIMEOUT_MS', 3000),
    healthPollIntervalMs: envInt(env, 'SEARCH_READER_MCP_HEALTH_INTERVAL_MS', 2000),
    dockerRunTimeoutMs: envInt(env, 'SEARCH_READER_MCP_DOCKER_RUN_TIMEOUT_MS', 8000),
    startupWindowMs: envInt(env, 'SEARCH_READER_MCP_STARTUP_WINDOW_MS', 600000),
    catalogTimeoutMs: envInt(env, 'SEARCH_READER_MCP_CATALOG_TIMEOUT_MS', 5000),
    httpTimeoutMs: envInt(env, 'SEARCH_READER_MCP_HTTP_TIMEOUT_MS', 120000),
  };
}
