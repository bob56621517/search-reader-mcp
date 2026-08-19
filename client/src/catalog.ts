import { DEFAULT_ANNOTATIONS, DEFAULT_READ_DESC, DEFAULT_SEARCH_DESC } from './desc';
import type { ServerHttp } from './server-http';

/**
 * /catalog 拉取(ADR-0009):工具级 desc/hints 单一来源是 server。
 * client 启动时拉取,成功 → 以 server 为准(catalog 只下发 desc/hints,inputSchema 不下发);
 * 失败(容器未运行)→ 退回本地内建默认。参数级 describe 由 client 自持,不受 catalog 影响。
 *
 * read 工具级 desc 例外:client 的 read 调用面与 server 不同(ADR-0009 明言,本地文件原生读取
 * 见 ADR-0010),server 内建 desc 描述的是"curl 上传引导模板",直接下发会与 client 原生本地文件
 * 行为冲突、误导 agent;故 read desc 始终用 client 本地默认(描述 file:// 原生读取),hints 仍与
 * server 一致。search 调用面相同,desc 严格单一来源 server。
 */

export interface ToolMeta {
  description: string;
  annotations: Record<string, boolean>;
}

export interface ToolMetadata {
  search: ToolMeta;
  read: ToolMeta;
}

export function buildDefaultMetadata(): ToolMetadata {
  return {
    search: { description: DEFAULT_SEARCH_DESC.description, annotations: DEFAULT_ANNOTATIONS },
    read: { description: DEFAULT_READ_DESC.description, annotations: DEFAULT_ANNOTATIONS },
  };
}

export async function resolveToolMetadata(http: ServerHttp): Promise<ToolMetadata> {
  try {
    const catalog = await http.catalog();
    const find = (name: string): ToolMeta | undefined => {
      const t = catalog.tools.find((x) => x.name === name);
      if (!t) return undefined;
      return { description: t.description ?? '', annotations: t.annotations ?? DEFAULT_ANNOTATIONS };
    };
    const search = find('search');
    const read = find('read');
    if (!search || !read || !search.description) {
      return buildDefaultMetadata();
    }
    return {
      // search 调用面与 server 相同:desc 严格单一来源 server
      search: { description: search.description, annotations: search.annotations },
      // read 调用面不同(ADR-0010):desc 用 client 本地默认(描述原生本地文件),hints 与 server 一致
      read: { description: DEFAULT_READ_DESC.description, annotations: read.annotations },
    };
  } catch {
    return buildDefaultMetadata();
  }
}
