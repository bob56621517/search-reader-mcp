'use strict';
// 纯逻辑单测:配置层(非 seam,直接打 dist/config.js)
// 覆盖:新增 env 默认值与覆盖、mcpDesc 结构一一对应、env 缺省/空串回退内建描述。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, buildMcpDesc } = require('../dist/config.js');

// ---- 新增 env:默认值 ----

test('SERVER_URL/READ_CACHE_TTL/READ_TIMEOUT 缺省时使用内建默认', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.serverUrl, 'http://localhost:18081');
  assert.equal(cfg.readCacheTtl, 300);
  assert.equal(cfg.readTimeout, 90);
});

test('SERVER_URL/READ_CACHE_TTL/READ_TIMEOUT env 有值时生效', () => {
  const cfg = loadConfig({
    SERVER_URL: 'https://reader.example.com',
    READ_CACHE_TTL: '600',
    READ_TIMEOUT: '120',
  });
  assert.equal(cfg.serverUrl, 'https://reader.example.com');
  assert.equal(cfg.readCacheTtl, 600);
  assert.equal(cfg.readTimeout, 120);
});

test('READ_CACHE_TTL/READ_TIMEOUT 非法值(非正数)回退默认', () => {
  const cfg = loadConfig({ READ_CACHE_TTL: 'abc', READ_TIMEOUT: '-5' });
  assert.equal(cfg.readCacheTtl, 300);
  assert.equal(cfg.readTimeout, 90);
});

// ---- mcpDesc:结构与工具/参数一一对应 ----

test('mcpDesc 缺省即内建描述(工具 + 全部参数)', () => {
  const cfg = loadConfig({});
  const search = cfg.mcpDesc.search;
  const read = cfg.mcpDesc.read;
  // search:工具 + type/query/count/freshness/include/exclude
  assert.match(search.description, /博查\(bocha\)搜索 MCP 工具/);
  assert.match(search.type, /搜索类型:ai/);
  assert.match(search.query, /搜索关键词/);
  assert.match(search.count, /返回条数上限/);
  assert.match(search.freshness, /时效:/);
  assert.match(search.include, /限定网站范围/);
  assert.match(search.exclude, /排除网站范围/);
  // read:工具 + uri/skip/length/engine/timeout
  assert.match(read.description, /将网页或 PDF/);
  assert.match(read.uri, /要读取的资源地址/);
  assert.match(read.skip, /跳过开头字符数/);
  assert.match(read.length, /返回切片长度/);
  assert.match(read.engine, /抓取引擎:/);
  assert.match(read.timeout, /整体超时预算/);
  // 结构键一一对应(不随工具演化遗漏)
  assert.deepEqual(Object.keys(search).sort(), ['count', 'description', 'exclude', 'freshness', 'include', 'query', 'type']);
  assert.deepEqual(Object.keys(read).sort(), ['description', 'engine', 'length', 'skip', 'timeout', 'uri']);
});

test('mcpDesc 全部 MCP_* env 可覆盖 search 描述', () => {
  const desc = buildMcpDesc({
    MCP_SEARCH_DESC: '搜索描述-X',
    MCP_SEARCH_TYPE: '类型-X',
    MCP_SEARCH_QUERY: '查询-X',
    MCP_SEARCH_COUNT: '数量-X',
    MCP_SEARCH_FRESHNESS: '时效-X',
    MCP_SEARCH_INCLUDE: '包含-X',
    MCP_SEARCH_EXCLUDE: '排除-X',
  });
  assert.equal(desc.search.description, '搜索描述-X');
  assert.equal(desc.search.type, '类型-X');
  assert.equal(desc.search.query, '查询-X');
  assert.equal(desc.search.count, '数量-X');
  assert.equal(desc.search.freshness, '时效-X');
  assert.equal(desc.search.include, '包含-X');
  assert.equal(desc.search.exclude, '排除-X');
});

test('mcpDesc 全部 MCP_* env 可覆盖 read 描述', () => {
  const desc = buildMcpDesc({
    MCP_READ_DESC: '读取描述-X',
    MCP_READ_URI: '地址-X',
    MCP_READ_SKIP: '跳过-X',
    MCP_READ_LENGTH: '长度-X',
    MCP_READ_ENGINE: '引擎-X',
    MCP_READ_TIMEOUT: '超时-X',
  });
  assert.equal(desc.read.description, '读取描述-X');
  assert.equal(desc.read.uri, '地址-X');
  assert.equal(desc.read.skip, '跳过-X');
  assert.equal(desc.read.length, '长度-X');
  assert.equal(desc.read.engine, '引擎-X');
  assert.equal(desc.read.timeout, '超时-X');
});

test('mcpDesc env 只覆盖有值的项,其余回退内建', () => {
  const desc = buildMcpDesc({ MCP_SEARCH_TYPE: '仅覆盖类型', MCP_READ_ENGINE: '仅覆盖引擎' });
  assert.equal(desc.search.type, '仅覆盖类型');
  assert.match(desc.search.description, /博查/);
  assert.match(desc.search.query, /搜索关键词/);
  assert.equal(desc.read.engine, '仅覆盖引擎');
  assert.match(desc.read.description, /将网页或 PDF/);
  assert.match(desc.read.length, /返回切片长度/);
});

test('mcpDesc env 空串视为缺省,回退内建', () => {
  const desc = buildMcpDesc({ MCP_SEARCH_DESC: '', MCP_READ_TIMEOUT: '' });
  assert.match(desc.search.description, /博查/);
  assert.match(desc.read.timeout, /整体超时预算/);
});

test('mcpDesc 注入 Config.mcpDesc(loadConfig 透传)', () => {
  const cfg = loadConfig({ MCP_READ_DESC: '经 loadConfig 覆盖' });
  assert.equal(cfg.mcpDesc.read.description, '经 loadConfig 覆盖');
});
