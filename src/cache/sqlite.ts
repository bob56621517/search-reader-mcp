import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * sqlite 缓存基础设施 + read 一级缓存(v7#02)。
 * 用 Node 24 内置 node:sqlite,零额外依赖;库文件默认落于持久化数据目录
 * (compose 外挂宿主 ~/.search_reader_mcp → 容器 /app/extension/data)。
 *
 * read 缓存只缓存解析后的 markdown 全文(不缓存原始字节),键 = `uri(含 query)+ engine`;
 * TTL 滑动续期(命中即 `expire_at = now + TTL`)、惰性删除(访问到过期即删重抓)+
 * 每小时兜底清理;并发同键 in-flight 去重,不同 engine 互不等待。
 * 缓存文件落于库文件同目录 `read-cache/`,文件名为 `sha256(键)`。
 */
export class CacheDb {
  private db: DatabaseSync;
  /** 缓存文件目录(与库文件同目录下 read-cache/) */
  private readonly cacheDir: string;
  /** in-flight 去重:缓存键 → 进行中的加载 Promise */
  private readonly inflight = new Map<string, Promise<string>>();
  private sweeper?: ReturnType<typeof setInterval>;

  private constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.cacheDir = join(dirname(path), 'read-cache');
    mkdirSync(this.cacheDir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  static open(path: string): CacheDb {
    return new CacheDb(path);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS read_cache (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uri        TEXT NOT NULL,
        engine     TEXT NOT NULL,
        cache_path TEXT NOT NULL,
        expire_at  INTEGER NOT NULL,        -- epoch ms
        UNIQUE(uri, engine)
      )
    `);
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', '2');
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.db.close();
  }

  // ---- read 缓存 ----

  /** 缓存键:`[uri, engine]` 的 JSON 序列化(分隔无歧义,URI/engine 任意字符均安全) */
  private readKey(uri: string, engine: string): string {
    return JSON.stringify([uri, engine]);
  }

  private cacheFile(uri: string, engine: string): string {
    const hash = createHash('sha256').update(this.readKey(uri, engine)).digest('hex');
    return join(this.cacheDir, `${hash}.md`);
  }

  /**
   * 命中(未过期)返回缓存内容并滑动续期;过期或文件缺失时惰性删除并返回 null。
   * ttlMs 为续期窗口(env READ_CACHE_TTL 秒 × 1000)。
   */
  getRead(uri: string, engine: string, ttlMs: number, now: number = Date.now()): string | null {
    const row = this.db
      .prepare('SELECT * FROM read_cache WHERE uri = ? AND engine = ?')
      .get(uri, engine) as ReadCacheRow | undefined;
    if (!row) return null;
    if (row.expire_at <= now) {
      this.evictRow(row);
      return null;
    }
    let content: string;
    try {
      content = readFileSync(row.cache_path, 'utf8');
    } catch {
      // 缓存文件缺失视同失效,删行重抓
      this.evictRow(row);
      return null;
    }
    // 命中后滑动续期
    this.db.prepare('UPDATE read_cache SET expire_at = ? WHERE id = ?').run(now + ttlMs, row.id);
    return content;
  }

  /**
   * 写缓存文件 + 记录索引;同键重复写覆盖并重置过期时间(幂等)。
   * 只由成功路径调用(loader 抛错不写缓存,避免缓存坏结果)。
   * 缓存写失败(磁盘/库异常)一律吞掉:缓存只是加速器,写失败只失去缓存机会,
   * 不应让已经成功的抓取结果因写缓存而变成失败。
   */
  putRead(
    uri: string,
    engine: string,
    content: string,
    ttlMs: number,
    now: number = Date.now(),
  ): void {
    try {
      const cachePath = this.cacheFile(uri, engine);
      writeFileSync(cachePath, content, 'utf8');
      this.db
        .prepare(
          `INSERT INTO read_cache (uri, engine, cache_path, expire_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(uri, engine) DO UPDATE SET
             cache_path = excluded.cache_path,
             expire_at  = excluded.expire_at`,
        )
        .run(uri, engine, cachePath, now + ttlMs);
    } catch {
      // 忽略缓存写错误:下次 miss 重新抓取即可,不影响本次返回
    }
  }

  /**
   * 兜底清理(每小时):仅按时间戳删 `expire_at < now` 的行及其缓存文件,返回删除行数。
   * 新写入的行 `expire_at = now + TTL > now`,不会被误删(不误删并发写入)。
   */
  sweepReadExpired(now: number = Date.now()): number {
    const rows = this.db
      .prepare('SELECT * FROM read_cache WHERE expire_at <= ?')
      .all(now) as unknown as ReadCacheRow[];
    for (const row of rows) this.evictRow(row);
    return rows.length;
  }

  private evictRow(row: ReadCacheRow): void {
    this.db.prepare('DELETE FROM read_cache WHERE id = ?').run(row.id);
    try {
      rmSync(row.cache_path, { force: true });
    } catch {
      // 文件已不存在等场景忽略,行已删除即可
    }
  }

  /**
   * 读缓存或加载:命中直接返回(瞬时,不占 timeout 预算);
   * miss 时经 loader 拉取并写缓存;同键并发共享同一进行中 Promise(in-flight 去重,
   * 完成后移除),不同 engine 独立等待;loader 抛错不写缓存、异常上抛。
   * now 仅用于缓存查找时点(过期判断);写缓存的过期基准取 loader 完成时刻(Date.now())。
   */
  getOrFetchRead(
    uri: string,
    engine: string,
    ttlMs: number,
    loader: () => Promise<string>,
    now: number = Date.now(),
  ): Promise<string> {
    const key = this.readKey(uri, engine);
    const running = this.inflight.get(key);
    if (running) return running;
    const cached = this.getRead(uri, engine, ttlMs, now);
    if (cached != null) return Promise.resolve(cached);
    const pending = (async () => {
      const content = await loader();
      // 只缓存成功结果:loader 抛错到不了这行,缓存不写
      // 写入基准 = 写入完成时刻 Date.now(),而非请求开始时刻 now(参数默认值):
      // 若 loader(抓取)耗时 ≥ TTL,用 now 算出的 expire_at 在写入瞬间已过期 → 写入即失效(08 冒烟发现)
      this.putRead(uri, engine, content, ttlMs, Date.now());
      return content;
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  /** 启动定时兜底清理(每小时);返回前 unref,不阻塞进程退出;close() 时停止 */
  startSweeper(intervalMs: number): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.sweepReadExpired();
    }, intervalMs);
    this.sweeper.unref();
  }
}

interface ReadCacheRow {
  id: number;
  uri: string;
  engine: string;
  cache_path: string;
  expire_at: number;
}
