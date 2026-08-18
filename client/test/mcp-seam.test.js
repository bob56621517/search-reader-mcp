'use strict';
// 主接缝测试(spec「Testing Decisions」):MCP 协议边界。
// 官方 @modelcontextprotocol/sdk Client 经 stdio 连接真实 client(进程内跑 dist/index.js),
// 调用 tools/list 与 tools/call 断言结果;外部依赖在注入点打桩——server HTTP 由测试进程内的
// 假 http server 承担(SERVER_URL 指过去),docker 由假命令脚本承担(SEARCH_READER_MCP_DOCKER
// 指过去),本地文件用临时 fixture。不触真实 server/容器。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CLIENT_ENTRY = path.join(__dirname, '..', 'dist', 'index.js');
const FOUR_HINTS = { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 4000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50);
  }
  throw new Error(`waitUntil 超时(${timeoutMs}ms)${lastErr ? `: ${lastErr.message}` : ''}`);
}

// ---- 假 server HTTP:行为由 state 控制(alive 模拟容器可用性) ----
function makeState() {
  return {
    alive: true,
    searchDesc: '自定义搜索描述',
    readDesc: '自定义读取描述',
    searchCalls: [],
    readCalls: [],
    uploads: [],
  };
}

function startFakeServer(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const collect = (cb) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => cb(Buffer.concat(chunks)));
    };
    // health:容器可用性由 alive 模拟(ADR-0011 探测)
    if (req.method === 'GET' && (p === '/health' || p === '/')) {
      if (state.alive) json(200, { service: 'search-reader-mcp', status: 'ok' });
      else { res.writeHead(503); res.end(); }
      return;
    }
    // catalog:alive=false 时模拟容器未运行不可达(→ client 回退本地内建 desc)
    if (req.method === 'GET' && p === '/catalog') {
      if (!state.alive) { res.writeHead(503); res.end(); return; }
      json(200, {
        tools: [
          { name: 'search', description: state.searchDesc, annotations: FOUR_HINTS },
          { name: 'read', description: state.readDesc, annotations: FOUR_HINTS },
        ],
      });
      return;
    }
    // search:POST /search/<type> JSON body
    if (req.method === 'POST' && p.startsWith('/search/')) {
      if (!state.alive) { res.writeHead(503); res.end(); return; } // 容器不可达模拟
      collect((buf) => {
        state.searchCalls.push({
          type: p.slice('/search/'.length),
          body: JSON.parse(buf.toString('utf8') || '{}'),
        });
        json(200, {
          summary: 'AI 总结',
          webPages: [{ name: '示例页', url: 'https://example.com', siteName: 'ex', snippet: '片段' }],
          modalCards: [],
          followUpQuestions: ['追问1'],
        });
      });
      return;
    }
    // read http(s):POST /read/<url> 选项入 body
    if (req.method === 'POST' && p.startsWith('/read/')) {
      if (!state.alive) { res.writeHead(503); res.end(); return; } // 容器不可达模拟
      collect((buf) => {
        state.readCalls.push({
          rest: p.slice('/read/'.length),
          body: JSON.parse(buf.toString('utf8') || '{}'),
        });
        res.writeHead(200, { 'content-type': 'text/markdown' });
        res.end('FULL-MARKDOWN-CONTENT');
      });
      return;
    }
    // read 上传:POST /read multipart(字段 file),不缓存
    if (req.method === 'POST' && p === '/read') {
      if (!state.alive) { res.writeHead(503); res.end(); return; } // 容器不可达模拟
      collect((buf) => {
        state.uploads.push({ contentType: req.headers['content-type'] || '', body: buf });
        res.writeHead(200, { 'content-type': 'text/markdown' });
        res.end('UPLOADED-MARKDOWN');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, state }),
    );
  });
}

// ---- 假 docker 命令脚本:命令/结果由 env 控制,调用记录到 FAKE_DOCKER_LOG ----
const FAKE_DOCKER_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (log) { try { fs.appendFileSync(log, JSON.stringify(args) + '\\n'); } catch {} }
const cmd = args[0];
const stderr = process.env.FAKE_DOCKER_STDERR || '';
const exit = (code) => { if (stderr) process.stderr.write(stderr); process.exit(code); };
const codeOf = (name) => Number(process.env[name] || '0');
if (cmd === 'info') exit(codeOf('FAKE_DOCKER_INFO_CODE'));
if (cmd === 'run') exit(codeOf('FAKE_DOCKER_RUN_CODE'));
if (cmd === 'start') exit(codeOf('FAKE_DOCKER_START_CODE'));
exit(1);
`;

function writeFakeDocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-fakedocker-'));
  const scriptPath = path.join(dir, 'fake-docker.cjs');
  fs.writeFileSync(scriptPath, FAKE_DOCKER_SCRIPT);
  if (process.platform !== 'win32') fs.chmodSync(scriptPath, 0o755);
  const dockerBin = process.platform === 'win32' ? `node "${scriptPath}"` : scriptPath;
  return { dockerBin, scriptPath, logPath: path.join(dir, 'calls.log') };
}

function cleanupFake(fake) {
  fs.rmSync(path.dirname(fake.scriptPath), { recursive: true, force: true });
}

function baseEnv(port, fake, extra = {}) {
  return {
    ...process.env,
    SERVER_URL: `http://127.0.0.1:${port}`,
    SEARCH_READER_MCP_DOCKER: fake.dockerBin,
    SEARCH_READER_MCP_HEALTH_INTERVAL_MS: '50',
    SEARCH_READER_MCP_HEALTH_TIMEOUT_MS: '200',
    SEARCH_READER_MCP_DOCKER_RUN_TIMEOUT_MS: '500',
    SEARCH_READER_MCP_STARTUP_WINDOW_MS: '3000',
    FAKE_DOCKER_LOG: fake.logPath,
    ...extra,
  };
}

async function connectClient(port, fake, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLIENT_ENTRY],
    env: baseEnv(port, fake, { BOCHA_API_KEY: 'k', ...extraEnv }),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function stopClient(client, transport) {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  const proc = transport.process;
  if (proc && proc.exitCode === null) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }
}

/** 直接 spawn client(不连 MCP),等退出,返回 exit code + stderr(启动失败场景) */
function spawnAndWaitExit(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_ENTRY], { env });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 场景 A:容器已运行 → 复用;desc 来自 /catalog;search/read 代理;本地文件上传;相对路径指令
// ---------------------------------------------------------------------------
test('A 容器已运行:catalog desc/hints + search/read 代理 + 本地文件上传 + 相对路径指令', async () => {
  const state = makeState();
  state.alive = true;
  const { server, port } = await startFakeServer(state);
  const fake = writeFakeDocker();
  try {
    const { client, transport } = await connectClient(port, fake);
    try {
      // tools/list:search desc 单一来源 /catalog(ADR-0009);read 调用面不同(ADR-0010),
      // desc 由 client 自决(本地默认,描述原生本地文件),hints 仍与 server 一致
      const { tools } = await client.listTools();
      const search = tools.find((t) => t.name === 'search');
      const read = tools.find((t) => t.name === 'read');
      assert.equal(search.description, '自定义搜索描述');
      assert.match(read.description, /本地文件/);
      assert.match(read.description, /绝对 OS 路径/);
      for (const t of [search, read]) {
        assert.equal(t.annotations.readOnlyHint, true);
        assert.equal(t.annotations.idempotentHint, true);
        assert.equal(t.annotations.openWorldHint, true);
        assert.equal(t.annotations.destructiveHint, false);
      }
      // inputSchema 由 client 本地 zod 自持(catalog 不下发 schema)
      assert.deepEqual(Object.keys(search.inputSchema.properties).sort(), ['count', 'exclude', 'freshness', 'include', 'query', 'type']);
      assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), ['engine', 'length', 'skip', 'timeout', 'uri']);

      // search → POST /search/ai(JSON body;count 钳制默认 20,freshness noLimit)
      const sres = await client.callTool({ name: 'search', arguments: { query: 'typescript' } });
      assert.equal(state.searchCalls.length, 1);
      assert.equal(state.searchCalls[0].type, 'ai');
      assert.equal(state.searchCalls[0].body.query, 'typescript');
      assert.equal(state.searchCalls[0].body.count, 20);
      assert.equal(state.searchCalls[0].body.freshness, 'noLimit');
      assert.match(sres.content[0].text, /https:\/\/example\.com/);

      // read http(s) → POST /read/<encoded url>,选项入 body;skip/length 本地切片
      const rres = await client.callTool({
        name: 'read',
        arguments: { uri: 'https://example.com/a?b=1' },
      });
      assert.equal(state.readCalls.length, 1);
      assert.equal(state.readCalls[0].rest, encodeURIComponent('https://example.com/a?b=1'));
      assert.deepEqual(state.readCalls[0].body, {}); // 未显式传 engine/timeout 时不入 body
      assert.equal(rres.content[0].text, 'FULL-MARKDOWN-CONTENT');

      // read 本地文件(file:/// 绝对 URI)→ 读取后 multipart POST /read(字段 file)
      const fixture = path.join(os.tmpdir(), `srm-fixture-${process.pid}.txt`);
      fs.writeFileSync(fixture, 'LOCAL-FILE-BYTES');
      const fres = await client.callTool({ name: 'read', arguments: { uri: pathToFileURL(fixture).href } });
      assert.equal(state.uploads.length, 1);
      assert.match(state.uploads[0].contentType, /multipart\/form-data/);
      const up = state.uploads[0].body.toString('utf8');
      assert.match(up, /name="file"/);
      assert.match(up, /LOCAL-FILE-BYTES/);
      assert.equal(fres.content[0].text, 'UPLOADED-MARKDOWN');

      // read 相对路径 → 指令文本,不解析(不新增 HTTP 调用,ADR-0010)
      const rrel = await client.callTool({ name: 'read', arguments: { uri: 'notes.md' } });
      assert.match(rrel.content[0].text, /read 工具无法解析/);
      assert.match(rrel.content[0].text, /相对路径/);
      assert.equal(state.readCalls.length, 1);
      assert.equal(state.uploads.length, 1);

      // read 其他 scheme(ftp)→ 指令文本(不解析)
      const rinval = await client.callTool({ name: 'read', arguments: { uri: 'ftp://example.com/x' } });
      assert.match(rinval.content[0].text, /read 工具无法解析/);
    } finally {
      await stopClient(client, transport);
    }
  } finally {
    server.close();
    cleanupFake(fake);
  }
});

// ---------------------------------------------------------------------------
// 场景 B:容器未运行 → 后台 docker run,窗口期返回"正在启动",health 命中后恢复
// ---------------------------------------------------------------------------
test('B 容器未运行:照常启动(窗口期返回"正在启动"),health 命中后工具恢复', async () => {
  const state = makeState();
  state.alive = false;
  const { server, port } = await startFakeServer(state);
  const fake = writeFakeDocker();
  try {
    const { client, transport } = await connectClient(port, fake);
    try {
      // catalog 拉取失败(容器未运行)→ 工具 desc 回退本地内建(非 /catalog 自定义)
      const { tools } = await client.listTools();
      assert.match(tools.find((t) => t.name === 'search').description, /博查/);
      assert.notEqual(tools.find((t) => t.name === 'search').description, '自定义搜索描述');
      // docker run 已被静默触发(常驻参数)
      const log = fs.readFileSync(fake.logPath, 'utf8');
      assert.ok(log.includes('"run"'), '应执行 docker run');
      assert.ok(log.includes('--restart'), '常驻 --restart unless-stopped');
      // 窗口期:工具调用返回"正在启动",不代理到 server
      const sres = await client.callTool({ name: 'search', arguments: { query: 'x' } });
      assert.match(sres.content[0].text, /正在启动/);
      assert.equal(state.searchCalls.length, 0);
      // health 命中 → 后台轮询转 ready → 工具恢复正常代理
      state.alive = true;
      await waitUntil(async () => {
        const res = await client.callTool({ name: 'search', arguments: { query: 'recover' } });
        return res.content[0].text.includes('https://example.com');
      });
      assert.ok(state.searchCalls.length > 0);
    } finally {
      await stopClient(client, transport);
    }
  } finally {
    server.close();
    cleanupFake(fake);
  }
});

// ---------------------------------------------------------------------------
// 场景 C:运行时容器挂掉 → 返回"容器未运行"指令文本,不自动重启(ADR-0011)
// ---------------------------------------------------------------------------
test('C 运行时容器挂掉:工具返回"容器未运行"指令文本(不自动重启)', async () => {
  const state = makeState();
  state.alive = true;
  const { server, port } = await startFakeServer(state);
  const fake = writeFakeDocker();
  try {
    const { client, transport } = await connectClient(port, fake);
    try {
      // 正常代理
      const ok = await client.callTool({ name: 'search', arguments: { query: 'ok' } });
      assert.match(ok.content[0].text, /https:\/\/example\.com/);
      const searchCallsBefore = state.searchCalls.length;
      // 容器运行中挂掉 → 后台轮询转 down
      state.alive = false;
      await waitUntil(async () => {
        const res = await client.callTool({ name: 'search', arguments: { query: 'gone' } });
        return res.content[0].text.includes('容器未运行');
      });
      // 返回指令文本含恢复动作(ADR-0007:报错即 prompt),且不再代理
      const down = await client.callTool({ name: 'read', arguments: { uri: 'https://example.com/x' } });
      assert.match(down.content[0].text, /docker start search-reader-mcp/);
      assert.equal(state.searchCalls.length, searchCallsBefore);
    } finally {
      await stopClient(client, transport);
    }
  } finally {
    server.close();
    cleanupFake(fake);
  }
});

// ---------------------------------------------------------------------------
// 场景 D:缺前置 → 启动失败退出,工具不注册(stderr 报错)
// ---------------------------------------------------------------------------
test('D1 docker 不可用 → 启动失败退出,stderr 报明原因', async () => {
  const state = makeState();
  state.alive = false;
  const { server, port } = await startFakeServer(state);
  const fake = writeFakeDocker();
  try {
    const { code, stderr } = await spawnAndWaitExit(
      baseEnv(port, fake, { BOCHA_API_KEY: 'k', FAKE_DOCKER_INFO_CODE: '1' }),
    );
    assert.equal(code, 1);
    assert.match(stderr, /docker 不可用/);
  } finally {
    server.close();
    cleanupFake(fake);
  }
});

test('D2 缺 REQUIRED_ENVS(BOCHA_API_KEY)→ 启动失败退出,工具不注册', async () => {
  const state = makeState();
  state.alive = false;
  const { server, port } = await startFakeServer(state);
  const fake = writeFakeDocker();
  try {
    // docker info 必须成功(默认 0),才能走到 REQUIRED_ENVS 检查(ADR-0011 顺序:health→docker→env)
    const env = baseEnv(port, fake);
    delete env.BOCHA_API_KEY; // 确保子进程也不含该变量
    const { code, stderr } = await spawnAndWaitExit(env);
    assert.equal(code, 1);
    assert.match(stderr, /缺少必填环境变量: BOCHA_API_KEY/);
  } finally {
    server.close();
    cleanupFake(fake);
  }
});
