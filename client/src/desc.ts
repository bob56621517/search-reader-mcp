/**
 * client 本地默认工具描述(ADR-0009 的降级兜底)。
 * 工具级 desc/hints 的单一来源是 server(/catalog,ADR-0009);client 启动时若能拉到 catalog
 * 即以 server 为准,仅在 catalog 拉取失败(容器未运行)时退回此处内建默认——与 server 内建
 * 描述一致,缺的只是 server 侧 MCP_* env 的自定义。参数级 describe 属于 inputSchema,
 * 由 client 自持(ADR-0009),此处即其默认值。
 */

export interface SearchDesc {
  description: string;
  type: string;
  query: string;
  count: string;
  freshness: string;
  include: string;
  exclude: string;
}

export interface ReadDesc {
  description: string;
  uri: string;
  skip: string;
  length: string;
  engine: string;
  timeout: string;
}

/** 四项 hint 默认(与 server/src/mcp/annotations.ts 对齐;catalog 失败时兜底) */
export const DEFAULT_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

export const DEFAULT_SEARCH_DESC: SearchDesc = {
  description:
    '博查(bocha)搜索 MCP 工具。type 缺省为 ai(AI 语义搜索):除网页来源外还返回大模型总结答案、追问问题与垂域模态卡,适合事实问答/综述;需要排除特定网站或只要裸网页列表时显式 type="web"。返回的网页来源请在回答末尾把 URL 渲染为超链接附上,便于用户溯源。',
  type: '搜索类型:ai(默认,AI 语义搜索,含总结/追问/模态卡)或 web(网页长摘要列表,支持 exclude)',
  query: '搜索关键词',
  count: '返回条数上限,默认 20,最大 50(越界自动钳制)',
  freshness: '时效:noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear,或 YYYY-MM-DD..YYYY-MM-DD 日期范围',
  include: '限定网站范围:根域名或子域名,多个用 | 或 , 分隔,最多 100 个;web/ai 均支持',
  exclude: '排除网站范围:同上;仅 type="web" 生效',
};

export const DEFAULT_READ_DESC: ReadDesc = {
  description:
    'agent 读取工具:读取 uri 并转换为 Markdown 文本。远程 url(http(s)://)由服务端直接抓取转换;本地文件(绝对 OS 路径或 file:/// 绝对 URI)由 client 读取后上传解析取回;相对路径返回指令文本不解析(ADR-0010)。上传解析支持 web(.html)、Word(.doc/.docx)、Excel(.xls/.xlsx)、PowerPoint(.ppt/.pptx)、PDF 及其他文档类文件。',
  uri: '要读取的资源地址:http(s):// 远程网页/PDF,或本地文件绝对 OS 路径 / file:/// 绝对 URI;相对路径返回指令文本',
  skip: '跳过开头字符数(默认 0),用于分片续读长文',
  length: '返回切片长度(默认 5000,上限 50000);全文不足时不截断',
  engine: '抓取引擎:auto(默认,智能选择)/direct(轻量无 JS)/browser(浏览器渲染)',
  timeout: '单次读取整体超时预算(秒,≤600);缓存命中不消耗预算',
};
