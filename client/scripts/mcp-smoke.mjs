#!/usr/bin/env node
// client 冒烟脚本(spec「Testing Decisions」主接缝,以 client 为主):
// 官方 @modelcontextprotocol/sdk 的 Client 经 stdio 连接真实 client(dist/index.js),
// 调用 tools/list 与 tools/call,断言 Agent 实际体验到的契约;server 容器由 client 自动
// 检测/启动(需真实 docker + BOCHA_API_KEY)。任一项失败以 exit 1 退出(可直接作 CI 门禁)。
//
// 用法:
//   node client/scripts/mcp-smoke.mjs                # 默认 SERVER_URL=http://localhost:18081
//   node client/scripts/mcp-smoke.mjs http://host:port
//   SEARCH_READER_MCP_IMAGE=... node client/scripts/mcp-smoke.mjs   # 覆盖镜像 tag 等
//
// 前置:client 已构建(`cd client && npm run build`);docker daemon 运行;宿主有 BOCHA_API_KEY。
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');
const BASE_URL = process.argv[2] || 'http://localhost:18081';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
  } else {
    console.log(`[FAIL] ${name}${detail ? ' → ' + detail : ''}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连接真实 client(stdio);client 内部会 health 探测并(条件满足时)自动启动容器 */
function connectClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLIENT_ENTRY],
    env: {
      ...process.env,
      SERVER_URL: BASE_URL,
      // 冒烟环境调短轮询/窗口,加速就绪判定(默认 2s/10min;拉镜像仍允许较久)
      SEARCH_READER_MCP_HEALTH_INTERVAL_MS: process.env.SEARCH_READER_MCP_HEALTH_INTERVAL_MS || '2000',
      SEARCH_READER_MCP_STARTUP_WINDOW_MS: process.env.SEARCH_READER_MCP_STARTUP_WINDOW_MS || '300000',
    },
  });
  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
  return { transport, connect: client.connect(transport), client };
}

/** 工具调用,等待容器从 starting 转为可用(自动重启逻辑由 client 后台轮询完成) */
async function callToolReady(client, name, args, timeoutMs = 180000) {
  const start = Date.now();
  for (;;) {
    const res = await client.callTool({ name, arguments: args });
    const text = String(res?.content?.[0]?.text ?? '');
    if (!text.includes('正在启动')) return res;
    if (Date.now() - start > timeoutMs) return res;
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// 段 A:连接真实 client,验证 Agent 体验到的工具契约
// ---------------------------------------------------------------------------
const { transport, connect, client } = connectClient();
try {
  await connect;
  console.error(`[mcp-smoke] client stdio 已连接(server=${BASE_URL})`);

  // ---- tools/list:search/read + 四项 hint 全声明(ADR-0009/OpenAI 目录要求) ----
  const { tools } = await client.listTools();
  const search = tools.find((t) => t.name === 'search');
  const read = tools.find((t) => t.name === 'read');
  check('tools/list 返回 search/read', !!search && !!read, `tools=${tools.map((t) => t.name).join(',')}`);
  if (search && read) {
    let hintsOk = true;
    for (const t of [search, read]) {
      const a = t.annotations || {};
      hintsOk =
        hintsOk &&
        a.readOnlyHint === true &&
        a.idempotentHint === true &&
        a.openWorldHint === true &&
        a.destructiveHint === false;
    }
    check('search/read 四项 hint 全声明(含 destructiveHint:false)', hintsOk, JSON.stringify([search.annotations, read.annotations]));
    // read desc 描述 client 原生本地文件调用面(ADR-0010)
    check('read 工具描述含本地文件能力', /本地文件|绝对 OS 路径/.test(read.description), read.description.slice(0, 120));
  }

  // ---- read:http(s) 抓取 → Markdown(URL Source 干净) ----
  const readFull = await callToolReady(client, 'read', { uri: 'http://example.com' });
  const readFullText = String(readFull?.content?.[0]?.text ?? '');
  check('read(uri=http(s)) 抓取返回 Markdown', readFullText.includes('Example Domain'), readFullText.slice(0, 150));
  check('read 返回无 ?url= 污染', !readFullText.includes('?url='), '');

  // ---- read:切片 + 截断提示 / 完整返回无提示 ----
  const readTrunc = await client.callTool({ name: 'read', arguments: { uri: 'http://example.com', skip: 0, length: 80 } });
  const truncText = String(readTrunc?.content?.[0]?.text ?? '');
  check(
    'read 切片截断提示(length 小于全文)',
    /\[内容已截断:全文约 \d+ 字符,当前返回 \d+-\d+/.test(truncText),
    truncText.slice(0, 200),
  );

  const readAll = await client.callTool({ name: 'read', arguments: { uri: 'http://example.com', length: 50000 } });
  const allText = String(readAll?.content?.[0]?.text ?? '');
  check('read 完整返回(length 足够大)无截断提示', !allText.includes('[内容已截断'), allText.slice(0, 100));

  // ---- read:本地文件(file:/// 绝对 URI)→ 上传解析(ADR-0010) ----
  const fixture = path.join(os.tmpdir(), `srm-smoke-${process.pid}.md`);
  fs.writeFileSync(fixture, '# 冒烟本地文件\n\n本地文件上传解析冒烟样本。');
  try {
    const local = await client.callTool({ name: 'read', arguments: { uri: pathToFileURL(fixture).href } });
    const localText = String(local?.content?.[0]?.text ?? '');
    check('read(file:/// 绝对 URI)上传解析返回 Markdown', localText.length > 0, localText.slice(0, 120));
  } finally {
    fs.rmSync(fixture, { force: true });
  }

  // ---- read:相对路径 → 指令文本,不解析(ADR-0010) ----
  const rel = await client.callTool({ name: 'read', arguments: { uri: 'notes.md' } });
  const relText = String(rel?.content?.[0]?.text ?? '');
  check('read(相对路径)返回指令文本不解析', /read 工具无法解析/.test(relText) && /相对路径/.test(relText), relText.slice(0, 150));

  // ---- search:web / ai / count 钳制 / freshness 回退(行为锚定) ----
  const isSearchOk = (t) => t.length > 0 && !t.includes('搜索失败') && !t.includes('"code":');
  const searchWeb = await client.callTool({ name: 'search', arguments: { type: 'web', query: 'hello world', count: 3 } });
  const sw = String(searchWeb?.content?.[0]?.text ?? '');
  check('search(type=web) 返回编号网页列表', (sw.includes('1. ') || sw.includes('未找到相关结果')) && isSearchOk(sw), sw.slice(0, 200));

  const searchAi = await client.callTool({ name: 'search', arguments: { query: 'hello world' } });
  check('search 默认 type=ai 正常返回', isSearchOk(String(searchAi?.content?.[0]?.text ?? '')), String(searchAi?.content?.[0]?.text ?? '').slice(0, 200));

  const searchClamp = await client.callTool({ name: 'search', arguments: { type: 'web', query: 'hello world', count: 999 } });
  check('search count=999 钳制 1..50,正常返回', isSearchOk(String(searchClamp?.content?.[0]?.text ?? '')), String(searchClamp?.content?.[0]?.text ?? '').slice(0, 200));

  const searchFresh = await client.callTool({ name: 'search', arguments: { type: 'web', query: 'hello world', count: 2, freshness: 'garbage' } });
  check('search freshness=非法值 回退 noLimit,正常返回', isSearchOk(String(searchFresh?.content?.[0]?.text ?? '')), String(searchFresh?.content?.[0]?.text ?? '').slice(0, 200));
} finally {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  if (transport.process && transport.process.exitCode === null) {
    try {
      transport.process.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }
}

// ---------------------------------------------------------------------------
// 段 B:启动失败语义(缺必填配置 → 正常 MCP 失败路径退出,工具不注册)
//   用不可达 SERVER_URL 避免依赖容器运行状态;docker 不可用场景由单测 D1 覆盖。
// ---------------------------------------------------------------------------
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

const failEnv = {
  ...process.env,
  SERVER_URL: 'http://127.0.0.1:1', // 必然不可达 → 触发 docker/REQUIRED_ENVS 检查
  SEARCH_READER_MCP_HEALTH_TIMEOUT_MS: '300',
};
delete failEnv.BOCHA_API_KEY; // 显式剔除,模拟缺必填配置
const { code, stderr } = await spawnAndWaitExit(failEnv);
check(
  '缺 BOCHA_API_KEY → 启动失败退出码 1,stderr 报明原因',
  code === 1 && /缺少必填环境变量: BOCHA_API_KEY/.test(stderr),
  `code=${code} stderr=${stderr.slice(0, 200)}`,
);

// ---- 汇总 ----
console.log(failures === 0 ? '\n全部 client 冒烟检查通过' : `\n${failures} 项 client 冒烟检查失败`);
process.exit(failures === 0 ? 0 : 1);
