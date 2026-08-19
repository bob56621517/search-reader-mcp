'use strict';
// HTTP seam 契约测试:GET /catalog 工具目录元数据(ADR-0009)。
// 返回 {tools:[{name, description, annotations}]},annotations 四项显式含 destructiveHint:false;
// desc 来自 config.mcpDesc(MCP_* env 可覆盖),inputSchema 不下发。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../dist/server.js');
const { makeTmpDir, makeTestConfig } = require('./http-helper.js');

const tmpDir = makeTmpDir('catalog');

function testConfig(overrides = {}) {
  return makeTestConfig(tmpDir, overrides);
}

test('GET /catalog 返回 search/read 的 name/description/annotations(四项显式含 destructiveHint:false)', async () => {
  const app = await createApp({ config: testConfig() });
  const res = await request(app.callback()).get('/catalog').expect(200);
  const { tools } = res.body;
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['read', 'search']);
  for (const t of tools) {
    assert.ok(t.description.length > 0, 'description 非空');
    assert.deepEqual(t.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      destructiveHint: false,
    });
  }
});

test('GET /catalog 的 desc 复用 config.mcpDesc(env 可覆盖,client 自动同步)', async () => {
  const app = await createApp({
    config: testConfig({ MCP_SEARCH_DESC: '自定义搜索描述', MCP_READ_DESC: '自定义读取描述' }),
  });
  const res = await request(app.callback()).get('/catalog').expect(200);
  const { tools } = res.body;
  assert.equal(tools.find((t) => t.name === 'search').description, '自定义搜索描述');
  assert.equal(tools.find((t) => t.name === 'read').description, '自定义读取描述');
});

test('GET /catalog 不下发 inputSchema(ADR-0009,schema 由 client 自持)', async () => {
  const app = await createApp({ config: testConfig() });
  const res = await request(app.callback()).get('/catalog').expect(200);
  for (const t of res.body.tools) {
    assert.ok(!('inputSchema' in t), 'catalog 不下发 inputSchema');
  }
});

test('GET /catalog 仅接受 GET,其他 method 返回 405', async () => {
  const app = await createApp({ config: testConfig() });
  await request(app.callback()).post('/catalog').expect(405);
  await request(app.callback()).delete('/catalog').expect(405);
});
