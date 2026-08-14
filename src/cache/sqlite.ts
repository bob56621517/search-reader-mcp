import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * sqlite 缓存基础设施(先建库、不接任何功能缓存)。
 * 用 Node 24 内置 node:sqlite,零额外依赖;库文件默认落于持久化数据目录
 * (compose 外挂宿主 ~/.search_reader_mcp → 容器 /app/extension/data)。
 */
export class CacheDb {
  private db: DatabaseSync;

  private constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  static open(path: string): CacheDb {
    return new CacheDb(path);
  }

  private migrate(): void {
    // 占位:后续接入缓存时在此建 search_cache / read_cache 等表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', '1');
  }

  close(): void {
    this.db.close();
  }
}
