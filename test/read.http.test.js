'use strict';
// HTTP seam 契约测试:read 全量挂载 + query 保留 + bodyParser 分流 + 缓存 + timeout(v7#03)
// 单一接缝,supertest 直接打 koa app;mock jina 桥接(handler 捕获 res),不依赖真实 jina/容器。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../dist/config.js');
const { createApp } = require('../dist/server.js');

const tmpDir = path.join(os.tmpdir(), `srm-read-${process.pid}`);

function testConfig(overrides = {}) {
  return loadConfig({ BOCHA_API_KEY: 'test-key', SEARCH_READER_MCP_DATA: tmpDir, ...overrides });
}

/**
 * mock jina 桥接:
 *  - handler 记录收到的 req.url(供 query 保留断言),并按 opts.respond 写捕获 res。
 *  - respond 缺省:status 200 + markdown body;可传自定义函数,或 null 表示挂起(测超时)。
 */
function mockJina(opts = {}) {
  const calls = [];
  const handler = (req, res) => {
    calls.push({ url: req.url, headers: req.headers });
    if (opts.handler) return opts.handler(req, res);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.end('# from jina');
  };
  return { handler, calls };
}

async function makeApp(config = testConfig(), jina) {
  return createApp({ config, jina });
}

// ---- 全量挂载 + query 保留 ----

test('GET /read/<url> 保留 query string 透传 jina', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig(), jina);
  const res = await request(app.callback())
    .get('/read/' + encodeURIComponent('http://example.com') + '?a=1&b=2')
    .expect(200);
  assert.equal(res.text, '# from jina');
  // 改写 req.url 时必须保留原始 query string(fix bug)
  assert.equal(jina.calls.length, 1);
  assert.equal(jina.calls[0].url, '/http://example.com?a=1&b=2');
});

test('GET /r/<url> 与 /read 同义(query 编码在路径内也能还原)', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig(), jina);
  const res = await request(app.callback())
    .get('/r/' + encodeURIComponent('http://example.com/x?a=1'))
    .expect(200);
  assert.equal(res.text, '# from jina');
  assert.equal(jina.calls[0].url, '/http://example.com/x?a=1');
});

test('POST /read(无尾路径)上传解析透传 jina,不缓存、不吞 multipart', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig(), jina);
  const res = await request(app.callback())
    .post('/read')
    .attach('file', Buffer.from('# pdf bytes'), 'a.pdf', { contentType: 'application/pdf' })
    .expect(200);
  assert.equal(res.text, '# from jina');
  // 上传不写缓存:再次 POST 仍走 jina
  await request(app.callback()).post('/read').attach('file', Buffer.from('x'), 'b.txt').expect(200);
  assert.equal(jina.calls.length, 2);
});

test('非 GET 带 URL(POST /read/<url>)透传 jina,不缓存', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig(), jina);
  const res = await request(app.callback())
    .post('/read/' + encodeURIComponent('http://example.com'))
    .expect(200);
  assert.equal(res.text, '# from jina');
  await request(app.callback())
    .post('/read/' + encodeURIComponent('http://example.com'))
    .expect(200);
  assert.equal(jina.calls.length, 2); // 透传,未缓存
});

// ---- 缓存接入 ----

test('同键(uri+engine)第二次 GET 命中缓存,jina 不重复抓取', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '300' }), jina);
  const url = '/read/' + encodeURIComponent('http://cached.com');
  const r1 = await request(app.callback()).get(url).expect(200);
  assert.equal(r1.text, '# from jina');
  assert.equal(jina.calls.length, 1);
  // 第二次命中缓存:jina 不再调用,返回同内容
  const r2 = await request(app.callback()).get(url).expect(200);
  assert.equal(r2.text, '# from jina');
  assert.equal(jina.calls.length, 1);
  assert.match(r2.headers['content-type'], /text\/markdown/);
});

test('不同 engine 缓存键隔离(不串缓存)', async () => {
  const jina = mockJina();
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '300' }), jina);
  const url = '/read/' + encodeURIComponent('http://engine.com');
  await request(app.callback()).get(url).expect(200); // engine auto
  await request(app.callback()).get(url).set('X-Engine', 'browser').expect(200); // engine browser
  assert.equal(jina.calls.length, 2);
  // 再以 auto 请求命中第一份缓存
  await request(app.callback()).get(url).expect(200);
  assert.equal(jina.calls.length, 2);
});

test('TTL 过期后惰性删除重抓(seam 效用例)', async () => {
  const jina = mockJina();
  // TTL 1 秒:第一次抓取写缓存,睡 1.1s 过期后第二次应重新抓取
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '1' }), jina);
  const url = '/read/' + encodeURIComponent('http://ttl.com');
  await request(app.callback()).get(url).expect(200);
  assert.equal(jina.calls.length, 1);
  await new Promise((r) => setTimeout(r, 1100));
  await request(app.callback()).get(url).expect(200);
  assert.equal(jina.calls.length, 2);
});

test('jina 非 200 不写缓存,原样透传状态码', async () => {
  const jina = mockJina({
    handler: (req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('not found');
    },
  });
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '300' }), jina);
  const url = '/read/' + encodeURIComponent('http://nf.com');
  const r1 = await request(app.callback()).get(url).expect(404);
  assert.equal(r1.text, 'not found');
  // 未缓存:再次请求仍走 jina
  await request(app.callback()).get(url).expect(404);
  assert.equal(jina.calls.length, 2);
});

// ---- timeout ----

test('X-Read-Timeout 超时返回 504,且不写缓存', async () => {
  const jina = mockJina({ handler: () => {} }); // 挂起,永不 end
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '300' }), jina);
  const res = await request(app.callback())
    .get('/read/' + encodeURIComponent('http://slow.com'))
    .set('X-Read-Timeout', '0.1')
    .expect(504);
  assert.match(res.body.error, /超时/);
});

test('缺省 X-Read-Timeout 走 env READ_TIMEOUT(0.05s 触发 504)', async () => {
  const jina = mockJina({ handler: () => {} });
  const app = await makeApp(testConfig({ READ_CACHE_TTL: '300', READ_TIMEOUT: '0.05' }), jina);
  await request(app.callback())
    .get('/read/' + encodeURIComponent('http://slow.com'))
    .expect(504);
});

test('POST /read 上传路径同样受整体硬超时保护(504)', async () => {
  const jina = mockJina({ handler: () => {} }); // 挂起,永不 end
  const app = await makeApp(testConfig(), jina);
  await request(app.callback())
    .post('/read')
    .attach('file', Buffer.from('# x'), 'a.pdf', { contentType: 'application/pdf' })
    .set('X-Read-Timeout', '0.1')
    .expect(504);
});

// ---- health / 边界 ----

test('read 无 jina 桥接时返回 503', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/r/' + encodeURIComponent('http://example.com')).expect(503);
  await request(app.callback()).get('/read/' + encodeURIComponent('https://a.com')).expect(503);
});

test('read 无尾路径无 jina 返回 503(全量挂载透传 jina /)', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/r').expect(503);
  await request(app.callback()).get('/read').expect(503);
  await request(app.callback()).post('/read').attach('file', Buffer.from('x'), 'a.txt').expect(503);
});

test('health 不受 read 全量挂载影响', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/health').expect(200);
  await request(app.callback()).get('/').expect(200);
});
