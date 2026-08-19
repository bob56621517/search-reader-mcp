'use strict';
// 纯逻辑单测:read 一级缓存(v7#02,非 seam,直接打 dist/cache/sqlite.js)
// 覆盖:写入/命中/过期重抓/滑动续期/兜底清理只删过期/in-flight 同键只抓一次/loader 失败不写缓存。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CacheDb } = require('../dist/cache/sqlite.js');

const TTL = 1000; // 测试用小 TTL(ms)

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cache-'));
  const db = CacheDb.open(path.join(dir, 'cache.db'));
  return { db, dir };
}

test('写入后命中返回内容', () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://a.com?x=1', 'auto', '# hello', TTL);
    assert.equal(db.getRead('https://a.com?x=1', 'auto', TTL), '# hello');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过期后惰性删除并返回 null(触发重抓)', () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://a.com', 'auto', 'old', TTL, 1000);
    // expire_at = 2000;2500 已过期 → 删旧返回 null
    assert.equal(db.getRead('https://a.com', 'auto', TTL, 2500), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('命中后滑动续期:续期可延长存活', () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://a.com', 'auto', 'body', TTL, 0);
    // t=500 命中,续期到 1500
    assert.equal(db.getRead('https://a.com', 'auto', TTL, 500), 'body');
    // t=1200 已超过原过期(1000),因滑动续期仍命中
    assert.equal(db.getRead('https://a.com', 'auto', TTL, 1200), 'body');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('兜底清理只删过期行,未过期保留', () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://expired.com', 'auto', 'E', TTL, 0); // expire 1000
    db.putRead('https://alive.com', 'auto', 'A', 100000, 0); // expire 100000
    assert.equal(db.sweepReadExpired(1500), 1);
    assert.equal(db.getRead('https://expired.com', 'auto', TTL, 2000), null);
    assert.equal(db.getRead('https://alive.com', 'auto', TTL, 2000), 'A');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight 同键并发只加载一次', async () => {
  const { db, dir } = tmpDb();
  try {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return 'fresh';
    };
    const [a, b] = await Promise.all([
      db.getOrFetchRead('https://a.com', 'auto', TTL, loader),
      db.getOrFetchRead('https://a.com', 'auto', TTL, loader),
    ]);
    assert.equal(calls, 1);
    assert.equal(a, 'fresh');
    assert.equal(b, 'fresh');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不同 engine 互不等待,各自加载', async () => {
  const { db, dir } = tmpDb();
  try {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 'x';
    };
    await Promise.all([
      db.getOrFetchRead('https://a.com', 'curl', TTL, loader),
      db.getOrFetchRead('https://a.com', 'browser', TTL, loader),
    ]);
    assert.equal(calls, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loader 抛错不写缓存、异常上抛,缓存不被污染', async () => {
  const { db, dir } = tmpDb();
  try {
    const failing = async () => {
      throw new Error('抓取失败');
    };
    await assert.rejects(() => db.getOrFetchRead('https://a.com', 'auto', TTL, failing), /抓取失败/);
    assert.equal(db.getRead('https://a.com', 'auto', TTL), null); // 未写缓存
    // 再次调用仍走 loader(未被失败结果污染)
    let calls = 0;
    const ok = async () => {
      calls++;
      return 'ok';
    };
    assert.equal(await db.getOrFetchRead('https://a.com', 'auto', TTL, ok), 'ok');
    assert.equal(calls, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同键重复 put 覆盖内容并重置过期', () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://a.com', 'auto', 'v1', TTL, 0);
    db.putRead('https://a.com', 'auto', 'v2', 100000, 0);
    assert.equal(db.getRead('https://a.com', 'auto', TTL, 5000), 'v2');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存命中时 loader 不被调用(瞬时返回)', async () => {
  const { db, dir } = tmpDb();
  try {
    db.putRead('https://a.com', 'auto', 'cached', TTL);
    let calls = 0;
    const loader = async () => {
      calls++;
      return 'fresh';
    };
    assert.equal(await db.getOrFetchRead('https://a.com', 'auto', TTL, loader), 'cached');
    assert.equal(calls, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getOrFetchRead 缓存过期后重新加载(惰性重抓)', async () => {
  const { db, dir } = tmpDb();
  try {
    // 写入基准为写入完成时刻(真实时间),故用真实等待模拟过期
    const TTL_SHORT = 120; // ms
    let calls = 0;
    const loader = async () => {
      calls++;
      return 'v' + calls;
    };
    // miss → loader 抓取并写缓存(expire = 写入完成 + TTL)
    assert.equal(await db.getOrFetchRead('https://a.com', 'auto', TTL_SHORT, loader), 'v1');
    assert.equal(calls, 1);
    // 有效期内命中,不再 loader
    assert.equal(await db.getOrFetchRead('https://a.com', 'auto', TTL_SHORT, loader), 'v1');
    assert.equal(calls, 1);
    // 等 TTL 过期后惰性删除并重新 loader
    await new Promise((r) => setTimeout(r, TTL_SHORT + 80));
    assert.equal(await db.getOrFetchRead('https://a.com', 'auto', TTL_SHORT, loader), 'v2');
    assert.equal(calls, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loader 耗时 ≥ TTL 时写缓存不失效(写入用完成时刻)', async () => {
  const { db, dir } = tmpDb();
  try {
    const TTL_SMALL = 50; // ms
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 120)); // loader 耗时 120ms > TTL 50ms
      return 'v' + calls;
    };
    // miss → loader(120ms)写缓存;修复前 expire_at = 请求开始 + 50,写入瞬间已过期 → 写入即失效
    assert.equal(await db.getOrFetchRead('https://slow.com', 'auto', TTL_SMALL, slow), 'v1');
    // 写入完成后立即再取:应命中缓存(写入完成 + TTL 仍有效),loader 不再执行
    assert.equal(await db.getOrFetchRead('https://slow.com', 'auto', TTL_SMALL, slow), 'v1');
    assert.equal(calls, 1); // 修复前此断言失败(calls=2,第二次重新 loader)
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
