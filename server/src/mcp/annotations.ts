/**
 * MCP 工具 hint 常量(四项全声明,含 destructiveHint:false)。
 * /catalog(server.ts)与 MCP 工具注册(mcp/server.ts)共用此单一来源,
 * 避免两处声明漂移(ADR-0009/OpenAI 目录要求:四项 hint 全声明)。
 */
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;
