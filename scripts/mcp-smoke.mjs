#!/usr/bin/env node
// MCP 冒烟:验证 /mcp(streamable HTTP)的初始化、工具列表与工具调用。
// 用法:node scripts/mcp-smoke.mjs [BASE_URL]  默认 http://localhost:18081
const base = process.argv[2] || 'http://localhost:18081';

async function rpc(method, params, extraHeaders = {}) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  return { sid: res.headers.get('mcp-session-id'), text: await res.text() };
}

const init = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '1.0' },
});
const sid = init.sid;
console.log('session:', sid);

await fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});

const tools = await rpc('tools/list', {}, { 'Mcp-Session-Id': sid });
console.log('tools/list:', tools.text.slice(0, 200));

const read = await rpc('tools/call', { name: 'read', arguments: { url: 'http://example.com' } }, { 'Mcp-Session-Id': sid });
console.log('READ tool:', read.text.slice(0, 250));

const search = await rpc('tools/call', { name: 'search', arguments: { type: 'web', query: 'hello', count: 2 } }, { 'Mcp-Session-Id': sid });
console.log('SEARCH tool:', search.text.slice(0, 250));
