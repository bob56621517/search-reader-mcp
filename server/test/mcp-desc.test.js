'use strict';
// 纯逻辑单测:MCP search 工具描述 env 化(经 config.mcpDesc 注入)。
// 覆盖:env 覆盖后工具/参数描述随之变化;env 缺省回退内建;行为不变(默认 ai/count 钳制/freshness 回退/异常可读文本)。
//
// spec「Testing Decisions」要求 mcpDesc 覆盖为纯函数单测、不经 MCP 传输;
// buildMcpDesc 的 env 纯逻辑已由 config.test.js 覆盖。本文件刻意经 InMemory 传输
// (内存内、快速、无外部依赖)补验证「描述确实注入到工具 schema」这一接线层,
// 即 v7「描述 env 化」验收「env 覆盖后工具/参数描述随之变化」;这是该约定最小的越界。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { buildMcpDesc } = require('../dist/config.js');
const { createMcpServer } = require('../dist/mcp/server.js');

function fakeBocha() {
  return {
    aiSearch: async (query, opts) => ({
      summary: 'AI 总结',
      modalCards: [],
      pages: [{ name: '示例页', url: 'https://example.com', siteName: 'example' }],
      followUpQuestions: ['追问1'],
    }),
    webSearch: async () => [],
  };
}

/** 构造 server + in-memory client(自定 bocha),返回已连通的 client */
async function connect(bocha, desc) {
  const server = createMcpServer({
    bocha,
    readUrl: async () => 'md',
    config: { serverUrl: 'http://localhost:18081', readTimeout: 90, mcpDesc: desc },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

/** 取 search 工具注册信息(description + inputSchema) */
async function searchToolInfo(desc) {
  const client = await connect(fakeBocha(), desc);
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === 'search');
  } finally {
    await client.close();
  }
}

// ---- 描述:env 缺省回退内建 ----

test('search 工具与参数描述缺省回退内建(无 MCP_* env)', async () => {
  const tool = await searchToolInfo(buildMcpDesc({}));
  assert.match(tool.description, /博查\(bocha\)搜索 MCP 工具/);
  const p = tool.inputSchema.properties;
  assert.equal(p.type.description, '搜索类型:ai(默认,AI 语义搜索,含总结/追问/模态卡)或 web(网页长摘要列表,支持 exclude)');
  assert.equal(p.query.description, '搜索关键词');
  assert.equal(p.count.description, '返回条数上限,默认 20,最大 50(越界自动钳制)');
  assert.equal(p.freshness.description, '时效:noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear,或 YYYY-MM-DD..YYYY-MM-DD 日期范围');
  assert.equal(p.include.description, '限定网站范围:根域名或子域名,多个用 | 或 , 分隔,最多 100 个;web/ai 均支持');
  assert.equal(p.exclude.description, '排除网站范围:同上;仅 type="web" 生效');
});

// ---- 描述:env 覆盖 ----

test('MCP_SEARCH_* env 覆盖后工具与参数描述随之变化', async () => {
  const tool = await searchToolInfo(
    buildMcpDesc({
      MCP_SEARCH_DESC: '自定义搜索描述',
      MCP_SEARCH_TYPE: '自定义类型描述',
      MCP_SEARCH_QUERY: '自定义关键词描述',
      MCP_SEARCH_COUNT: '自定义条数描述',
      MCP_SEARCH_FRESHNESS: '自定义时效描述',
      MCP_SEARCH_INCLUDE: '自定义包含描述',
      MCP_SEARCH_EXCLUDE: '自定义排除描述',
    }),
  );
  assert.equal(tool.description, '自定义搜索描述');
  const p = tool.inputSchema.properties;
  assert.equal(p.type.description, '自定义类型描述');
  assert.equal(p.query.description, '自定义关键词描述');
  assert.equal(p.count.description, '自定义条数描述');
  assert.equal(p.freshness.description, '自定义时效描述');
  assert.equal(p.include.description, '自定义包含描述');
  assert.equal(p.exclude.description, '自定义排除描述');
});

test('MCP_SEARCH_* 只覆盖有值项,其余回退内建', async () => {
  const tool = await searchToolInfo(buildMcpDesc({ MCP_SEARCH_DESC: '仅覆盖工具描述', MCP_SEARCH_QUERY: '仅覆盖查询' }));
  assert.equal(tool.description, '仅覆盖工具描述');
  const p = tool.inputSchema.properties;
  assert.equal(p.query.description, '仅覆盖查询');
  assert.match(p.type.description, /搜索类型:ai/); // 未覆盖 → 内建
  assert.match(p.count.description, /返回条数上限/);
});

test('MCP_SEARCH_* env 空串视为缺省,回退内建', async () => {
  const tool = await searchToolInfo(buildMcpDesc({ MCP_SEARCH_DESC: '', MCP_SEARCH_QUERY: '' }));
  assert.match(tool.description, /博查/);
  assert.equal(tool.inputSchema.properties.query.description, '搜索关键词');
});

// ---- 行为不变:描述 env 化后调用行为与内建一致 ----

test('search 行为不变:默认 ai、count 钳制 1..50、freshness falsy 回退 noLimit', async () => {
  const calls = [];
  const bocha = {
    aiSearch: async (query, opts) => {
      calls.push({ kind: 'ai', query, opts });
      return { summary: 'S', modalCards: [], pages: [], followUpQuestions: [] };
    },
    webSearch: async (query, opts) => {
      calls.push({ kind: 'web', query, opts });
      return [];
    },
  };
  // 描述已 env 覆盖,行为必须不变
  const desc = buildMcpDesc({ MCP_SEARCH_DESC: '覆盖后描述' });
  const client = await connect(bocha, desc);
  try {
    // 默认 ai:count 缺省 20,freshness 缺省 noLimit
    await client.callTool({ name: 'search', arguments: { query: 'node' } });
    assert.equal(calls[0].kind, 'ai');
    assert.equal(calls[0].query, 'node');
    assert.equal(calls[0].opts.count, 20);
    assert.equal(calls[0].opts.freshness, 'noLimit');

    // count 越界钳制:freshness 空串回退 noLimit
    await client.callTool({ name: 'search', arguments: { query: 'node', count: 999, freshness: '' } });
    assert.equal(calls[1].opts.count, 50);
    assert.equal(calls[1].opts.freshness, 'noLimit');

    await client.callTool({ name: 'search', arguments: { query: 'node', count: -5 } });
    assert.equal(calls[2].opts.count, 1);

    // type=web 走 webSearch,include/exclude 透传
    await client.callTool({
      name: 'search',
      arguments: { type: 'web', query: 'node', count: 3, include: 'nodejs.org', exclude: 'baidu.com' },
    });
    assert.equal(calls[3].kind, 'web');
    assert.equal(calls[3].opts.include, 'nodejs.org');
    assert.equal(calls[3].opts.exclude, 'baidu.com');

    // 参数 schema 结构不变(6 个参数位仍在)
    const { tools } = await client.listTools();
    const names = Object.keys(tools.find((t) => t.name === 'search').inputSchema.properties);
    assert.deepEqual(names.sort(), ['count', 'exclude', 'freshness', 'include', 'query', 'type']);
  } finally {
    await client.close();
  }
});

test('search 行为不变:工具内部异常返回可读错误文本,不抛错', async () => {
  const bocha = {
    aiSearch: async () => {
      throw new Error('bocha 上游炸了');
    },
    webSearch: async () => [],
  };
  const client = await connect(bocha, buildMcpDesc({}));
  try {
    const res = await client.callTool({ name: 'search', arguments: { query: 'x' } });
    assert.equal(res.content[0].type, 'text');
    assert.match(res.content[0].text, /bocha 上游炸了/); // 可读错误文本,而非 protocol 错误
  } finally {
    await client.close();
  }
});

// ---- 四项 hint 全声明(ADR-0009/OpenAI 目录要求,与 /catalog 同源 TOOL_ANNOTATIONS) ----

test('search/read 工具声明四项 hint(含 destructiveHint:false)', async () => {
  const client = await connect(fakeBocha(), buildMcpDesc({}));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['read', 'search']);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name}.readOnlyHint`);
      assert.equal(t.annotations.idempotentHint, true, `${t.name}.idempotentHint`);
      assert.equal(t.annotations.openWorldHint, true, `${t.name}.openWorldHint`);
      assert.equal(t.annotations.destructiveHint, false, `${t.name}.destructiveHint`);
    }
  } finally {
    await client.close();
  }
});
