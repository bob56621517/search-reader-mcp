import { z } from 'zod';

/**
 * MCP read 工具的纯逻辑层(v7 spec「四」「六」「七」)。
 * 全部为纯函数/纯结构,不经 MCP 传输即可单测:
 *  - buildReadSchema:参数 schema(skip/length/timeout 越界由 zod 拒绝)
 *  - sliceText:切片 + 截断提示
 *  - renderUploadTemplate:非 http(s) 上传引导模板(SERVER_URL 渲染)
 *  - engineHeaderValue / resolveReadTimeout:engine/timeout 映射
 *  - isHttpScheme:scheme 分流
 */

/** engine 三枚举单一来源:类型、schema、映射共用,新增枚举只改一处 */
export const READ_ENGINES = ['auto', 'direct', 'browser'] as const;
export type ReadEngine = (typeof READ_ENGINES)[number];

/** read 工具默认切片长度(spec「四」,上限 50000) */
export const DEFAULT_READ_LENGTH = 5000;

/** read 工具参数描述(来自 config.mcpDesc.read,env 可覆盖) */
export interface ReadToolDesc {
  uri: string;
  skip: string;
  length: string;
  engine: string;
  timeout: string;
}

/** read 工具参数 schema;越界(负 skip、length 越界、非法 engine/timeout)由 zod 拒绝 */
export function buildReadSchema(desc: ReadToolDesc) {
  return {
    uri: z.string().min(1).describe(desc.uri),
    skip: z.number().int().nonnegative().optional().describe(desc.skip),
    length: z.number().int().min(1).max(50000).optional().describe(desc.length),
    engine: z.enum(READ_ENGINES).optional().describe(desc.engine),
    timeout: z.number().int().positive().max(600).optional().describe(desc.timeout),
  };
}

/**
 * 返回全文的 [skip, skip+length) 纯文本切片。
 * 截断(精确判断 skip+length < 全文长度)时尾部追加提示;完整返回不加提示。
 */
export function sliceText(full: string, skip: number, length: number): string {
  const end = Math.min(skip + length, full.length);
  const slice = full.slice(skip, end);
  if (skip + length < full.length) {
    return `${slice}\n\n[内容已截断:全文约 ${full.length} 字符,当前返回 ${skip}-${end}。可增大 length 或调 skip 续读剩余部分]`;
  }
  return slice;
}

/** engine 映射:direct → curl、browser → browser、auto/缺省 → 不传 */
export function engineHeaderValue(engine: ReadEngine | undefined): string | undefined {
  if (engine === 'direct') return 'curl';
  if (engine === 'browser') return 'browser';
  return undefined;
}

/** timeout 默认链:per-call timeout > config.readTimeout > 90 */
export function resolveReadTimeout(timeout: number | undefined, readTimeout: number): number {
  if (timeout !== undefined) return timeout;
  return readTimeout > 0 ? readTimeout : 90;
}

/** scheme 分流:仅 http(s) 由服务端直接抓取 */
export function isHttpScheme(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}

/** 非 http(s) uri 的上传引导模板;{SERVER_URL} 全部替换为 config.serverUrl */
const UPLOAD_TEMPLATE = String.raw`该资源的 scheme 无法由服务端直接抓取(服务端仅支持 http/https)。
请由你(agent)自行在本地下载该资源,再通过服务端的文件上传解析 API 取回 Markdown:

  curl -X POST {SERVER_URL}/read \
       -F 'file=@<本地文件路径>' \
       -H 'x-engine: auto' \
       -H 'x-retain-links: all' \
       -H 'x-retain-images: all'

参数解释(与服务端 read 工具功能对齐):
- -X POST                    上传解析走 POST
- {SERVER_URL}/read           服务端上传解析端点;{SERVER_URL} 即服务端对外地址
                             (当前 {SERVER_URL},默认 http://localhost:18081;云部署为公网地址)
- -F 'file=@<本地文件路径>'    以 multipart/form-data 上传文件,字段名固定 file;
                             支持 PDF / Word / Excel / PPT / HTML / 纯文本
- -H 'x-engine: auto'         解析引擎,对应 read 工具的 engine 参数:auto(默认,智能选择)/
                             direct(轻量无 JS)/ browser(浏览器渲染)
- -H 'x-retain-links: all'    保留页面中所有链接 URL(markdown 形式),默认全保留
- -H 'x-retain-images: all'   保留页面中所有图片 URL(markdown 形式),默认全保留

响应:返回该资源的 Markdown 正文,所有链接与图片 URL 均以 markdown 保留;
内容不递归嵌套解析(不展开链接指向的页面)。`;

/** 渲染上传引导模板:地址经 serverUrl 注入(不硬编码) */
export function renderUploadTemplate(serverUrl: string): string {
  // 用 split/join 而非 replaceAll:serverUrl 含 $&/$'/$$ 等字符时 replaceAll 替换语法会误解释
  return UPLOAD_TEMPLATE.split('{SERVER_URL}').join(serverUrl);
}
