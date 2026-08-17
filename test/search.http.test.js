'use strict';
// HTTP seam 契约测试:整合服务器路由层(spec「Testing Decisions」)
// 单一接缝,supertest 直接打 koa app;bocha 通过 mock 全局 fetch 隔离,不依赖真实网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../dist/config.js');
const { createApp } = require('../dist/server.js');

const tmpDir = path.join(os.tmpdir(), `srm-test-${process.pid}`);

function testConfig(overrides = {}) {
  return loadConfig({ BOCHA_API_KEY: 'test-key', SEARCH_READER_MCP_DATA: tmpDir, ...overrides });
}

/** mock 全局 fetch,记录请求体,返回固定 body */
function installFetch(body, status = 200) {
  const state = { captured: null };
  global.fetch = async (url, opts) => {
    state.captured = { url, opts: opts || {} };
    return { status, text: async () => JSON.stringify(body) };
  };
  return state;
}

const WEB_BODY = {
  code: 200,
  data: {
    webPages: {
      value: [
        { name: 'Foo', url: 'https://foo.com', siteName: 'foo', snippet: 'snip', summary: 'sum' },
      ],
    },
  },
};

const AI_BODY = {
  code: 200,
  messages: [
    { type: 'answer', content_type: '', content: '这是总结' },
    {
      type: 'source',
      content_type: 'webpage',
      content: JSON.stringify({ value: [{ name: 'A', url: 'https://a.com', siteName: 'a', snippet: 's', summary: '' }] }),
    },
    {
      type: 'source',
      content_type: 'weather_china',
      content: JSON.stringify([{ modelCard: { city: '北京', temp: '30' } }]),
    },
    { type: 'follow_up', content_type: '', content: JSON.stringify(['追问一', '追问二']) },
  ],
};

async function makeApp(config = testConfig()) {
  return createApp({ config });
}

// ---- GET:路径即 query ----

test('GET /s/<query> 走 ai 搜索并归集结果', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    const res = await request(app.callback()).get('/s/' + encodeURIComponent('今天天气如何')).expect(200);
    assert.match(state.captured.url, /\/v1\/ai-search$/);
    assert.equal(res.body.summary, '这是总结');
    assert.equal(res.body.webPages.length, 1);
    assert.equal(res.body.modalCards.length, 1);
    assert.deepEqual(res.body.followUpQuestions, ['追问一', '追问二']);
  } finally {
    global.fetch = orig;
  }
});

test('GET /search/ai/<query> 等价于 /s/<query>', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).get('/search/ai/' + encodeURIComponent('天气')).expect(200);
    assert.match(state.captured.url, /\/v1\/ai-search$/);
  } finally {
    global.fetch = orig;
  }
});

test('GET /search/web/<query> 走 web 搜索返回 webPages', async () => {
  const orig = global.fetch;
  const state = installFetch(WEB_BODY);
  try {
    const app = await makeApp();
    const res = await request(app.callback()).get('/search/web/' + encodeURIComponent('hello world')).expect(200);
    assert.match(state.captured.url, /\/v1\/web-search$/);
    assert.equal(res.body.webPages.length, 1);
    assert.equal(res.body.webPages[0].name, 'Foo');
  } finally {
    global.fetch = orig;
  }
});

test('GET 中文 query 正确解码并透传', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).get('/s/' + encodeURIComponent('今天天气 北京')).expect(200);
    const sent = JSON.parse(state.captured.opts.body);
    assert.equal(sent.query, '今天天气 北京');
  } finally {
    global.fetch = orig;
  }
});

test('GET 高级参数 count 钳制到 1..50', async () => {
  const orig = global.fetch;
  const state = installFetch(WEB_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).get('/search/web/' + encodeURIComponent('q') + '?count=999').expect(200);
    assert.equal(JSON.parse(state.captured.opts.body).count, 50);
    await request(app.callback()).get('/search/web/' + encodeURIComponent('q') + '?count=0').expect(200);
    assert.equal(JSON.parse(state.captured.opts.body).count, 1);
  } finally {
    global.fetch = orig;
  }
});

test('GET freshness 非法值回退 noLimit', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).get('/s/' + encodeURIComponent('q') + '?freshness=bogus').expect(200);
    assert.equal(JSON.parse(state.captured.opts.body).freshness, 'noLimit');
  } finally {
    global.fetch = orig;
  }
});

test('GET 缺少 query(无路径段)返回 400', async () => {
  const orig = global.fetch;
  installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).get('/s').expect(400);
    await request(app.callback()).get('/search/ai').expect(400);
    await request(app.callback()).get('/search/web').expect(400);
  } finally {
    global.fetch = orig;
  }
});

// ---- POST:JSON body ----

test('POST /search/ai JSON body 走 ai 搜索', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    const res = await request(app.callback()).post('/search/ai').send({ query: '天气', count: 5 }).expect(200);
    assert.match(state.captured.url, /\/v1\/ai-search$/);
    const sent = JSON.parse(state.captured.opts.body);
    assert.equal(sent.query, '天气');
    assert.equal(sent.count, 5);
    assert.equal(res.body.summary, '这是总结');
  } finally {
    global.fetch = orig;
  }
});

test('POST /s 等价 /search/ai(body)', async () => {
  const orig = global.fetch;
  const state = installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).post('/s').send({ query: '天气', include: 'example.com' }).expect(200);
    assert.equal(JSON.parse(state.captured.opts.body).query, '天气');
    assert.equal(JSON.parse(state.captured.opts.body).include, 'example.com');
  } finally {
    global.fetch = orig;
  }
});

test('POST /search/web JSON body 走 web 搜索', async () => {
  const orig = global.fetch;
  const state = installFetch(WEB_BODY);
  try {
    const app = await makeApp();
    const res = await request(app.callback()).post('/search/web').send({ query: 'q', exclude: 'bad.com' }).expect(200);
    assert.match(state.captured.url, /\/v1\/web-search$/);
    assert.equal(JSON.parse(state.captured.opts.body).exclude, 'bad.com');
    assert.equal(res.body.webPages.length, 1);
  } finally {
    global.fetch = orig;
  }
});

test('POST body 缺少 query 返回 400', async () => {
  const orig = global.fetch;
  installFetch(AI_BODY);
  try {
    const app = await makeApp();
    await request(app.callback()).post('/search/ai').send({}).expect(400);
    await request(app.callback()).post('/s').send({ query: '' }).expect(400);
  } finally {
    global.fetch = orig;
  }
});

// ---- 错误与鉴权 ----

test('未配置 BOCHA_API_KEY 返回 500 提示', async () => {
  const orig = global.fetch;
  installFetch(AI_BODY);
  try {
    const app = await makeApp(testConfig({ BOCHA_API_KEY: '' }));
    const res = await request(app.callback()).get('/s/' + encodeURIComponent('q')).expect(500);
    assert.match(res.body.error, /BOCHA_API_KEY/);
  } finally {
    global.fetch = orig;
  }
});

test('bocha 非 200 返回可读错误', async () => {
  const orig = global.fetch;
  installFetch({ code: 401, msg: 'unauthorized' }, 200);
  try {
    const app = await makeApp();
    const res = await request(app.callback()).get('/s/' + encodeURIComponent('q')).expect(500);
    assert.match(res.body.error, /401/);
    assert.match(res.body.error, /unauthorized/);
  } finally {
    global.fetch = orig;
  }
});

// ---- read(路径即 url;宿主单测时 jina 桥接为 null)----

test('read 无 jina 桥接时返回 503', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/r/' + encodeURIComponent('http://example.com')).expect(503);
  await request(app.callback()).get('/read/' + encodeURIComponent('https://a.com')).expect(503);
});

test('read 无尾路径全量挂载透传 jina /,无 jina 时返回 503(v7#03)', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/r').expect(503);
  await request(app.callback()).get('/read').expect(503);
});

test('精确匹配端点兼容尾斜杠(/health/ 等价 /health)', async () => {
  const app = await makeApp();
  await request(app.callback()).get('/health/').expect(200);
  await request(app.callback()).get('/health').expect(200);
});
