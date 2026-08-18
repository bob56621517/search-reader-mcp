'use strict';
// 生命周期状态机进程内单元测试(ADR-0011):health 探测/docker 前置/静默启动/失败语义/窗口期。
// server HTTP 与 docker 在注入点打桩(假 health 变量 + 假命令执行器),不触真实 docker/server。
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createLifecycle } = require('../dist/lifecycle.js');
const { loadClientConfig } = require('../dist/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`waitFor 超时:条件未满足(${timeoutMs}ms)`);
}

/** 假 server HTTP:health 由测试随时切换 */
function makeHttp() {
  let alive = false;
  return {
    http: { async health() { return alive; } },
    setAlive(v) { alive = v; },
  };
}

/** 假 docker:按命令返回预设结果,并记录所有调用 */
function makeDocker(overrides = {}) {
  const calls = [];
  const cfg = { infoCode: 0, runCode: 0, runStderr: '', startCode: 0, ...overrides };
  return {
    docker: {
      async run(args, opts) {
        calls.push({ args, opts });
        const cmd = args[0];
        if (cmd === 'info') return { code: cfg.infoCode, stdout: '', stderr: '' };
        if (cmd === 'run') return { code: cfg.runCode, stdout: '', stderr: cfg.runStderr };
        if (cmd === 'start') return { code: cfg.startCode, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: `unknown cmd ${cmd}` };
      },
    },
    calls,
  };
}

function makeConfig() {
  return loadClientConfig({
    SEARCH_READER_MCP_HEALTH_INTERVAL_MS: '20',
    SEARCH_READER_MCP_HEALTH_TIMEOUT_MS: '50',
    SEARCH_READER_MCP_STARTUP_WINDOW_MS: '120',
    SEARCH_READER_MCP_DATA: os.tmpdir(),
  });
}

// 记录本次测试创建的 lifecycle,afterEach 统一 stop,避免后台轮询 interval 让测试进程不退出
const active = [];
function trackedLifecycle(config, http, docker) {
  const lc = createLifecycle(config, http, docker);
  active.push(lc);
  return lc;
}

beforeEach(() => {
  process.env.BOCHA_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.BOCHA_API_KEY;
  for (const lc of active) lc.stop();
  active.length = 0;
});

test('health 命中 → 复用,静默 ready', async () => {
  const { http, setAlive } = makeHttp();
  const { docker, calls } = makeDocker();
  setAlive(true);
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.deepEqual(res, { ok: true });
  assert.equal(lc.status(), 'ready');
  // 已复用容器:不应触发任何 docker 命令
  assert.equal(calls.length, 0);
  lc.stop();
});

test('docker 不可用 → 启动失败(docker info 非 0)', async () => {
  const { http } = makeHttp();
  const { docker } = makeDocker({ infoCode: 1 });
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.equal(res.ok, false);
  assert.match(res.reason, /docker 不可用/);
});

test('缺 REQUIRED_ENVS(BOCHA_API_KEY)→ 启动失败,工具不注册', async () => {
  const { http } = makeHttp();
  const { docker } = makeDocker();
  delete process.env.BOCHA_API_KEY;
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.equal(res.ok, false);
  assert.match(res.reason, /缺少必填环境变量: BOCHA_API_KEY/);
});

test('条件齐备 → 后台 docker run(常驻参数),窗口期 starting;health 命中后 ready', async () => {
  const { http, setAlive } = makeHttp();
  const { docker, calls } = makeDocker();
  const config = makeConfig();
  const lc = trackedLifecycle(config, http, docker);
  const res = await lc.ensureStarted();
  assert.deepEqual(res, { ok: true });
  assert.equal(lc.status(), 'starting');

  // docker run 命令契约(ADR-0011):常驻、端口映射、透传 BOCHA_API_KEY、数据卷、镜像 tag
  const run = calls.find((c) => c.args[0] === 'run');
  assert.ok(run, '应执行 docker run');
  assert.deepEqual(run.args, [
    'run', '-d', '--name', config.containerName, '--restart', 'unless-stopped',
    '-p', `${config.hostPort}:18081`, '-e', 'BOCHA_API_KEY',
    '-v', `${config.dataVolume}:/app/extension/data`, config.image,
  ]);
  assert.equal(run.opts.killOnTimeout, false, '拉镜像超时不 kill,转为后台观察');

  // 容器就绪(health 命中)→ 轮询转 ready
  setAlive(true);
  await waitFor(() => lc.status() === 'ready');
  lc.stop();
});

test('docker run 报 name in use → 容错 docker start(常驻复用)', async () => {
  const { http } = makeHttp();
  const { docker, calls } = makeDocker({
    runCode: 1,
    runStderr: 'docker: Error response from daemon: Conflict. The container name "/search-reader-mcp" is already in use.',
  });
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.deepEqual(res, { ok: true });
  const start = calls.find((c) => c.args[0] === 'start');
  assert.ok(start, '应执行 docker start');
  assert.equal(start.args[1], 'search-reader-mcp');
  assert.equal(lc.status(), 'starting');
  lc.stop();
});

test('docker run 其他失败 → 启动失败', async () => {
  const { http } = makeHttp();
  const { docker } = makeDocker({ runCode: 1, runStderr: 'invalid reference format' });
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.equal(res.ok, false);
  assert.match(res.reason, /docker run 失败/);
});

test('docker run 超时(124)拉镜像 → 视为窗口期 starting,不判失败', async () => {
  const { http, setAlive } = makeHttp();
  const { docker } = makeDocker({ runCode: 124 });
  const lc = trackedLifecycle(makeConfig(), http, docker);
  const res = await lc.ensureStarted();
  assert.deepEqual(res, { ok: true });
  assert.equal(lc.status(), 'starting');
  setAlive(true);
  await waitFor(() => lc.status() === 'ready');
  lc.stop();
});

test('运行时容器挂掉 → down(不自动重启,ADR-0011)', async () => {
  const { http, setAlive } = makeHttp();
  const { docker } = makeDocker();
  setAlive(true);
  const lc = trackedLifecycle(makeConfig(), http, docker);
  await lc.ensureStarted();
  assert.equal(lc.status(), 'ready');
  // 容器运行中挂掉 → 轮询发现 health 失败 → down
  setAlive(false);
  await waitFor(() => lc.status() === 'down');
  // 不自动重启:不应有新的 docker run
  lc.stop();
});

test('starting 超过启动窗口仍未健康 → down(首次拉起即崩溃兜底)', async () => {
  const { http } = makeHttp();
  const { docker } = makeDocker();
  const lc = trackedLifecycle(makeConfig(), http, docker);
  await lc.ensureStarted();
  assert.equal(lc.status(), 'starting');
  await waitFor(() => lc.status() === 'down', 2000);
  lc.stop();
});
