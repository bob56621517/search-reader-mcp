import { z } from 'zod';
import type { ReadDesc, SearchDesc } from './desc';

/**
 * client 本地 inputSchema(ADR-0009:schema 由 client 自持,不经 /catalog 下发)。
 * search 镜像整合服务器参数(type/query/count/freshness/include/exclude,与 server mcp/server.ts 对齐);
 * read 为 {uri, skip, length, engine, timeout}(与 server buildReadSchema 对齐,越界由 zod 拒绝)。
 */

export function buildSearchSchema(desc: SearchDesc) {
  return {
    type: z.enum(['ai', 'web']).optional().describe(desc.type),
    query: z.string().describe(desc.query),
    count: z.number().int().optional().describe(desc.count),
    freshness: z.string().optional().describe(desc.freshness),
    include: z.string().optional().describe(desc.include),
    exclude: z.string().optional().describe(desc.exclude),
  };
}

export const READ_ENGINES = ['auto', 'direct', 'browser'] as const;

export function buildReadSchema(desc: ReadDesc) {
  return {
    uri: z.string().min(1).describe(desc.uri),
    skip: z.number().int().nonnegative().optional().describe(desc.skip),
    length: z.number().int().min(1).max(50000).optional().describe(desc.length),
    engine: z.enum(READ_ENGINES).optional().describe(desc.engine),
    timeout: z.number().int().positive().max(600).optional().describe(desc.timeout),
  };
}
