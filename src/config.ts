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
  /** 日志目录(.log/,每天滚动) */
  logDir: string;
  /** 服务端对外地址(提示词模板渲染端点),默认 http://localhost:18081 */
  serverUrl: string;
  /** read 缓存 TTL(秒),默认 600(10 分钟) */
  readCacheTtl: number;
  /** HTTP 层整体超时兜底(秒),默认 90 */
  readTimeout: number;
  /** MCP 工具/参数描述(env 可覆盖,缺省内建) */
  mcpDesc: McpDesc;
}

/**
 * MCP 工具与参数描述结构(描述 env 化,v7 spec「描述 env 化」)。
 * 显式枚举全部工具/参数,类型安全;缺省 = 内建描述,`MCP_*` env 有值覆盖。
 * search 参数清单见 v7「五」;read 参数清单见 v7「四」(uri/skip/length/engine/timeout)。
 */
export interface McpDesc {
  search: {
    /** 工具描述,env MCP_SEARCH_DESC */
    description: string;
    /** 参数 type,env MCP_SEARCH_TYPE */
    type: string;
    /** 参数 query,env MCP_SEARCH_QUERY */
    query: string;
    /** 参数 count,env MCP_SEARCH_COUNT */
    count: string;
    /** 参数 freshness,env MCP_SEARCH_FRESHNESS */
    freshness: string;
    /** 参数 include,env MCP_SEARCH_INCLUDE(单数,与代码参数一致) */
    include: string;
    /** 参数 exclude,env MCP_SEARCH_EXCLUDE */
    exclude: string;
  };
  read: {
    /** 工具描述,env MCP_READ_DESC */
    description: string;
    /** 参数 uri,env MCP_READ_URI */
    uri: string;
    /** 参数 skip,env MCP_READ_SKIP */
    skip: string;
    /** 参数 length,env MCP_READ_LENGTH */
    length: string;
    /** 参数 engine,env MCP_READ_ENGINE */
    engine: string;
    /** 参数 timeout,env MCP_READ_TIMEOUT */
    timeout: string;
  };
}

/** 内建描述:search 对齐现 mcp/server.ts 硬编码;read 对齐 v7「四」新工具参数设计 */
const DEFAULT_MCP_DESC: McpDesc = {
  search: {
    description:
      '博查(bocha)搜索 MCP 工具。type 缺省为 ai(AI 语义搜索):除网页来源外还返回大模型总结答案、追问问题与垂域模态卡,适合事实问答/综述;需要排除特定网站或只要裸网页列表时显式 type="web"。返回的网页来源请在回答末尾把 URL 渲染为超链接附上,便于用户溯源。',
    type: '搜索类型:ai(默认,AI 语义搜索,含总结/追问/模态卡)或 web(网页长摘要列表,支持 exclude)',
    query: '搜索关键词',
    count: '返回条数上限,默认 20,最大 50(越界自动钳制)',
    freshness: '时效:noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear,或 YYYY-MM-DD..YYYY-MM-DD 日期范围',
    include: '限定网站范围:根域名或子域名,多个用 | 或 , 分隔,最多 100 个;web/ai 均支持',
    exclude: '排除网站范围:同上;仅 type="web" 生效',
  },
  read: {
    description:
      'agent 读取工具:读取 uri 并转换为 Markdown 文本。远程 url(http(s)://)由服务端直接抓取转换;本地文件请先在本地下载,再按返回的上传引导模板,用 POST /read 上传解析取回,上传解析支持 web(.html)、Word(.doc/.docx)、Excel(.xls/.xlsx)、PowerPoint(.ppt/.pptx)。',
    uri: '要读取的资源地址(http/https 网页或 PDF);其他 scheme(file/ftp/data 等)返回可执行的上传引导模板',
    skip: '跳过开头字符数(默认 0),用于分片续读长文',
    length: '返回切片长度(默认 5000,上限 50000);全文不足时不截断',
    engine: '抓取引擎:auto(默认,智能选择)/direct(轻量无 JS)/browser(浏览器渲染)',
    timeout: '单次读取整体超时预算(秒,≤600);缓存命中不消耗预算',
  },
};

/** 从 env 读字符串,有值才覆盖(空串/缺省回退内建) */
function envStr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** 从 env 读秒数值,非法/缺省回退默认 */
function envSeconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 构建 mcpDesc:显式逐项从 env 读取,缺省内建(类型安全,不做动态循环) */
export function buildMcpDesc(env: NodeJS.ProcessEnv = process.env): McpDesc {
  const d = DEFAULT_MCP_DESC;
  return {
    search: {
      description: envStr(env, 'MCP_SEARCH_DESC', d.search.description),
      type: envStr(env, 'MCP_SEARCH_TYPE', d.search.type),
      query: envStr(env, 'MCP_SEARCH_QUERY', d.search.query),
      count: envStr(env, 'MCP_SEARCH_COUNT', d.search.count),
      freshness: envStr(env, 'MCP_SEARCH_FRESHNESS', d.search.freshness),
      include: envStr(env, 'MCP_SEARCH_INCLUDE', d.search.include),
      exclude: envStr(env, 'MCP_SEARCH_EXCLUDE', d.search.exclude),
    },
    read: {
      description: envStr(env, 'MCP_READ_DESC', d.read.description),
      uri: envStr(env, 'MCP_READ_URI', d.read.uri),
      skip: envStr(env, 'MCP_READ_SKIP', d.read.skip),
      length: envStr(env, 'MCP_READ_LENGTH', d.read.length),
      engine: envStr(env, 'MCP_READ_ENGINE', d.read.engine),
      timeout: envStr(env, 'MCP_READ_TIMEOUT', d.read.timeout),
    },
  };
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
    logDir: env.LOG_DIR || path.join(dataDir, '.log'),
    serverUrl: env.SERVER_URL || 'http://localhost:18081',
    readCacheTtl: envSeconds(env, 'READ_CACHE_TTL', 600),
    readTimeout: envSeconds(env, 'READ_TIMEOUT', 90),
    mcpDesc: buildMcpDesc(env),
  };
}
