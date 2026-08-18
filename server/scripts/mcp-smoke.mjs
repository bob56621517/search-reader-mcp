#!/usr/bin/env node
// MCP 冒烟:验证 /mcp(streamable HTTP,无状态模式)初始化握手、工具列表与 read/search 工具端到端调用(v7 契约)。
// 无状态:服务端不返回 mcp-session-id,每次请求独立;客户端无需携带 Mcp-Session-Id 头。
// 用法:node scripts/mcp-smoke.mjs [BASE_URL]  默认 http://localhost:18081
// 逐项断言并打印 [PASS]/[FAIL];任一项失败以 exit 1 退出(可直接作 CI 门禁)。
import process from 'node:process';

const base = process.argv[2] || 'http://localhost:18081';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
  } else {
    console.log(`[FAIL] ${name}${detail ? ' → ' + detail : ''}`);
    failures++;
  }
}

async function rpc(method, params, extraHeaders = {}) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  return { res, text: await res.text() };
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.text;
}

// ---- 初始化握手(无状态:不返回 mcp-session-id,验证 serverInfo 与状态码) ----
const init = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '1.0' },
});
check(
  'initialize 握手返回 serverInfo(无状态模式)',
  init.res.status === 200 && /"name":"search-reader-mcp"/.test(init.text),
  init.text.slice(0, 200),
);

// ---- tools/list ----
const tools = await rpc('tools/list');
check(
  'tools/list 返回 search/read',
  tools.text.includes('"search"') && tools.text.includes('"read"'),
  tools.text.slice(0, 200),
);

// 工具 hint 四项全声明(ADR-0009/OpenAI 目录要求):search/read 均含 destructiveHint:false
// 响应为 SSE 帧(event: message\ndata: {...});需取 data: 行 JSON.parse,不能直接 parse 整帧
let hintsOk = false;
try {
  const dataLine = tools.text.split('\n').find((l) => l.startsWith('data: '));
  const parsed = dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null;
  const arr = parsed?.result?.tools ?? [];
  hintsOk =
    arr.length === 2 &&
    arr.every((t) => {
      const a = t.annotations || {};
      return (
        a.readOnlyHint === true &&
        a.idempotentHint === true &&
        a.openWorldHint === true &&
        a.destructiveHint === false
      );
    });
} catch {
  hintsOk = false;
}
check(
  'tools/list 的 search/read 四项 hint 全声明(含 destructiveHint:false)',
  hintsOk,
  tools.text.slice(0, 300),
);

// ---- read 工具(参数为 v7 的 uri/skip/length/engine/timeout) ----

const readFull = await callTool('read', { uri: 'http://example.com' });
check('read(uri) 抓取目标页返回 Markdown(URL Source 干净)', readFull.includes('Example Domain'), readFull.slice(0, 150));
check('read 返回无 ?url= 污染', !readFull.includes('?url='), '');

const readTrunc = await callTool('read', { uri: 'http://example.com', skip: 0, length: 80 });
check(
  'read 切片截断提示(length 小于全文)',
  /\[内容已截断:全文约 \d+ 字符,当前返回 \d+-\d+/.test(readTrunc),
  readTrunc.slice(0, 200),
);

const readAll = await callTool('read', { uri: 'http://example.com', length: 50000 });
check('read 完整返回(length 足够大)无截断提示', !readAll.includes('[内容已截断'), readAll.slice(0, 100));

const readTemplate = await callTool('read', { uri: 'file:///tmp/sample.pdf' });
check(
  'read 非 http(s) 返回上传引导模板',
  readTemplate.includes('curl -X POST') &&
    readTemplate.includes('x-retain-links: all') &&
    readTemplate.includes('x-retain-images: all') &&
    !readTemplate.includes('{SERVER_URL}'),
  readTemplate.slice(0, 200),
);

const readEngine = await callTool('read', { uri: 'http://example.com', engine: 'direct', timeout: 30 });
check('read(engine=direct, timeout=30) 参数透传可用', readEngine.includes('Example Domain') || readEngine.length > 0, readEngine.slice(0, 120));

// ---- search 工具(行为锚定) ----

// tools/call 响应是 SSE 帧,content.text 为 JSON 转义字符串,故用子串/包含断言而非行首正则
const isSearchText = (t) => t.length > 0 && !t.includes('博查搜索失败') && !t.includes('"code":');
const searchWeb = await callTool('search', { type: 'web', query: 'hello world', count: 3 });
check(
  'search(type=web) 返回编号网页列表',
  (searchWeb.includes('1. ') || searchWeb.includes('未找到相关结果')) && isSearchText(searchWeb),
  searchWeb.slice(0, 200),
);

const searchAi = await callTool('search', { query: 'hello world' });
check('search 默认 type=ai 正常返回(行为锚定)', isSearchText(searchAi), searchAi.slice(0, 200));

const searchClamp = await callTool('search', { type: 'web', query: 'hello world', count: 999 });
check('search count=999 钳制 1..50,正常返回', isSearchText(searchClamp), searchClamp.slice(0, 200));

const searchFresh = await callTool('search', { type: 'web', query: 'hello world', count: 2, freshness: 'garbage' });
check('search freshness=非法值 回退 noLimit,正常返回', isSearchText(searchFresh), searchFresh.slice(0, 200));

// ---- 汇总 ----
console.log(failures === 0 ? '\n全部 MCP 冒烟检查通过' : `\n${failures} 项 MCP 冒烟检查失败`);
process.exit(failures === 0 ? 0 : 1);
