/**
 * read 结果本地切片(与 server src/mcp/read-tools.ts 的 sliceText 契约一致,跨树独立副本)。
 * skip/length 在 client 本地切片(ADR-0010):http 抓取与本地文件上传解析均返回全文,此处裁切。
 */

/** read 工具默认切片长度(对齐 server 契约,上限 50000) */
export const DEFAULT_READ_LENGTH = 5000;

/** 返回全文的 [skip, skip+length) 纯文本切片;截断时尾部追加提示,完整返回不加提示 */
export function sliceText(full: string, skip: number, length: number): string {
  const end = Math.min(skip + length, full.length);
  const slice = full.slice(skip, end);
  if (skip + length < full.length) {
    return `${slice}\n\n[内容已截断:全文约 ${full.length} 字符,当前返回 ${skip}-${end}。可增大 length 或调 skip 续读剩余部分]`;
  }
  return slice;
}
