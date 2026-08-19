import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * read 本地文件安全边界(ADR-0010)。
 * 入参统一为 uri:http(s):// 走服务端抓取;file:/// 绝对 URI 或绝对 OS 路径走本地文件
 * (client 读取后经 POST /read multipart 上传解析);相对路径一律返回指令文本不解析。
 * 本地文件不设白名单:安全边界 = MCP host 权限层 + OS 权限兜底。
 */

export type UriKind = 'http' | 'file' | 'relative' | 'invalid';

/** scheme 分流:仅 http(s) 由服务端直接抓取 */
export function isHttpScheme(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}

/** uri 分类(ADR-0010):http / 本地文件(绝对)/ 相对(不解析)/ 无法识别 */
export function classifyUri(uri: string): UriKind {
  const trimmed = uri.trim();
  if (!trimmed) return 'invalid';
  if (isHttpScheme(trimmed)) return 'http';
  // 仅 file:/// 绝对 URI(host 为空,ADR-0010);file://host(如 file://relative/…)视为
  // 非标准绝对 URI 归 invalid,避免被当作 UNC 网络路径的歧义
  if (/^file:\/\//i.test(trimmed)) {
    if (!/^file:\/\/\//i.test(trimmed)) return 'invalid';
    try {
      fileURLToPath(trimmed);
      return 'file';
    } catch {
      return 'invalid';
    }
  }
  if (path.isAbsolute(trimmed)) return 'file';
  // 其他 scheme(ftp:/data:…)或相对路径:不解析,返回指令文本
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return 'invalid';
  return 'relative';
}

/** 仅对 file 类 uri:file:// 转 OS 绝对路径,绝对 OS 路径原样返回 */
export function toAbsolutePath(uri: string): string {
  const trimmed = uri.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return fileURLToPath(trimmed);
  }
  return trimmed;
}

/** 相对路径/无法识别 uri 的指令文本(ADR-0010:不解析,引导修正调用) */
export function renderUnsupportedPathText(uri: string, kind: 'relative' | 'invalid'): string {
  const reason =
    kind === 'relative'
      ? '相对路径无法确定基准目录(相对"哪个目录"存在歧义,ADR-0010)'
      : '无法识别的资源地址(仅支持 http(s):// 远程与本地文件绝对路径)';
  const absExample = process.platform === 'win32' ? 'C:\\\\Users\\\\me\\\\doc.pdf' : '/home/me/doc.pdf';
  return (
    `read 工具无法解析该地址("${uri}"),原因:${reason}。请改用以下任一形式:\n` +
    `- http(s):// 远程网页/PDF URL —— 由服务端直接抓取转换为 Markdown;\n` +
    `- 本地文件绝对 OS 路径(如 ${absExample})或 file:/// 绝对 URI —— 由 client 读取本地文件后上传解析取回。\n` +
    `本地文件上传解析支持 web(.html)、Word(.doc/.docx)、Excel(.xls/.xlsx)、PowerPoint(.ppt/.pptx)、PDF 及其他文档类文件。`
  );
}
