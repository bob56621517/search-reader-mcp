'use strict';
// 纯逻辑单测:MCP read 工具的纯逻辑层(非 seam,直接打 dist/mcp/read-tools.js)
// 覆盖:切片 + 截断提示、模板渲染(SERVER_URL 注入)、参数 schema 越界拒绝、engine/timeout 映射、scheme 分流。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReadSchema,
  sliceText,
  renderUploadTemplate,
  engineHeaderValue,
  resolveReadTimeout,
  isHttpScheme,
} = require('../dist/mcp/read-tools.js');

const DESC = {
  uri: '要读取的资源地址',
  skip: '跳过开头字符数',
  length: '返回切片长度',
  engine: '抓取引擎',
  timeout: '超时预算',
};

// ---- 切片 + 截断提示 ----

test('sliceText:完整返回(切片未到文末边界且未截断)不加提示', () => {
  const full = 'a'.repeat(1000);
  // skip+length == full.length,未截断,不加提示
  const out = sliceText(full, 0, 1000);
  assert.equal(out, full);
});

test('sliceText:length 超过全文长度时不截断', () => {
  const full = 'a'.repeat(1000);
  const out = sliceText(full, 0, 5000);
  assert.equal(out, full);
});

test('sliceText:截断时尾部追加提示(含全文长度与当前位置)', () => {
  const full = 'a'.repeat(8000);
  const out = sliceText(full, 3000, 2000);
  // 切片 [3000, 5000)
  assert.equal(out.slice(0, 2000), 'a'.repeat(2000));
  assert.match(out, /\[内容已截断:全文约 8000 字符,当前返回 3000-5000。可增大 length 或调 skip 续读剩余部分\]/);
});

test('sliceText:skip 为 0 截断时 from 为 0', () => {
  const full = 'x'.repeat(6000);
  const out = sliceText(full, 0, 5000);
  assert.match(out, /当前返回 0-5000/);
});

// ---- 模板渲染(SERVER_URL 注入) ----

test('renderUploadTemplate:默认地址注入 http://localhost:18081', () => {
  const out = renderUploadTemplate('http://localhost:18081');
  assert.match(out, /curl -X POST http:\/\/localhost:18081\/read/);
  assert.match(out, /http:\/\/localhost:18081\/read\s+服务端上传解析端点/);
  assert.match(out, /-H 'x-engine: auto'/);
  assert.match(out, /-H 'x-retain-links: all'/);
  assert.match(out, /-H 'x-retain-images: all'/);
});

test('renderUploadTemplate:自定义 SERVER_URL 全部渲染,不残留占位符', () => {
  const out = renderUploadTemplate('https://reader.example.com:8443');
  assert.match(out, /curl -X POST https:\/\/reader\.example\.com:8443\/read/);
  // 模板内所有 {SERVER_URL} 位都被替换
  assert.ok(!out.includes('{SERVER_URL}'), '不应残留 {SERVER_URL} 占位符');
});

test('renderUploadTemplate:模板自包含(含 POST/上传字段/响应说明)', () => {
  const out = renderUploadTemplate('http://localhost:18081');
  assert.match(out, /-X POST\s+上传解析走 POST/);
  assert.match(out, /字段名固定 file/);
  assert.match(out, /所有链接与图片 URL 均以 markdown 保留/);
  assert.match(out, /不递归嵌套解析/);
});

// ---- 参数 schema:越界拒绝 ----

test('buildReadSchema:合法参数通过', () => {
  const schema = buildReadSchema(DESC);
  const r = schema.uri.safeParse('https://example.com');
  assert.equal(r.success, true);
  assert.equal(schema.skip.safeParse(0).success, true);
  assert.equal(schema.skip.safeParse(100).success, true);
  assert.equal(schema.length.safeParse(5000).success, true);
  assert.equal(schema.length.safeParse(1).success, true);
  assert.equal(schema.engine.safeParse('auto').success, true);
  assert.equal(schema.engine.safeParse('direct').success, true);
  assert.equal(schema.engine.safeParse('browser').success, true);
  assert.equal(schema.timeout.safeParse(90).success, true);
  assert.equal(schema.timeout.safeParse(600).success, true);
});

test('buildReadSchema:skip 负值拒绝', () => {
  const schema = buildReadSchema(DESC);
  assert.equal(schema.skip.safeParse(-1).success, false);
});

test('buildReadSchema:length 越界拒绝(0 与 >50000)', () => {
  const schema = buildReadSchema(DESC);
  assert.equal(schema.length.safeParse(0).success, false);
  assert.equal(schema.length.safeParse(50001).success, false);
});

test('buildReadSchema:engine 非法值拒绝', () => {
  const schema = buildReadSchema(DESC);
  assert.equal(schema.engine.safeParse('cf-browser-rendering').success, false);
  assert.equal(schema.engine.safeParse('').success, false);
});

test('buildReadSchema:timeout 越界拒绝(非正整数或 >600)', () => {
  const schema = buildReadSchema(DESC);
  assert.equal(schema.timeout.safeParse(0).success, false);
  assert.equal(schema.timeout.safeParse(-5).success, false);
  assert.equal(schema.timeout.safeParse(601).success, false);
});

// ---- engine/timeout 映射 ----

test('engineHeaderValue:direct→curl、browser→browser、auto/缺省→undefined', () => {
  assert.equal(engineHeaderValue('direct'), 'curl');
  assert.equal(engineHeaderValue('browser'), 'browser');
  assert.equal(engineHeaderValue('auto'), undefined);
  assert.equal(engineHeaderValue(undefined), undefined);
});

test('resolveReadTimeout:timeout 参数 > config.readTimeout > 90', () => {
  assert.equal(resolveReadTimeout(30, 90), 30);
  assert.equal(resolveReadTimeout(600, 90), 600);
  assert.equal(resolveReadTimeout(undefined, 120), 120);
  assert.equal(resolveReadTimeout(undefined, 0), 90); // 兜底 90
});

// ---- scheme 分流 ----

test('isHttpScheme:http/https 为 true', () => {
  assert.equal(isHttpScheme('http://example.com'), true);
  assert.equal(isHttpScheme('https://example.com/a?b=1'), true);
  assert.equal(isHttpScheme('  https://x.com  '), true);
});

test('isHttpScheme:非 http(s) 为 false', () => {
  assert.equal(isHttpScheme('file:///etc/passwd'), false);
  assert.equal(isHttpScheme('data:text/plain,hi'), false);
  assert.equal(isHttpScheme('ftp://example.com'), false);
  assert.equal(isHttpScheme('s3://bucket/key'), false);
  assert.equal(isHttpScheme(''), false);
});
