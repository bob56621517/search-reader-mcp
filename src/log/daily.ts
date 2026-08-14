import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 按天滚动的文件日志:每日一个文件 app-YYYY-MM-DD.log,写入持久化 .log/ 目录
 * (宿主 ~/.search_reader_mcp/.log/ → 容器 /app/extension/data/.log/)。
 * 跨天自动切换新文件;日志写入失败不拖垮服务。
 */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class DailyLogger {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(): string {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD(UTC)
    return join(this.dir, `app-${day}.log`);
  }

  private write(level: LogLevel, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try {
      appendFileSync(this.file(), line);
    } catch {
      // 日志写失败不应拖垮服务
    }
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }

  warn(msg: string): void {
    this.write('WARN', msg);
  }

  error(msg: string): void {
    this.write('ERROR', msg);
  }
}
