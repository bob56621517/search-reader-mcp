import * as path from 'node:path';
import type { Config } from '../config';

/**
 * read/ 的 jina 复用桥接(ADR-0003)。
 * 进程内 require 镜像编译产物 build/stand-alone/crawl.js 的 CrawlStandAloneServer,
 * 取其 koaApp(完整爬取中间件栈:Chrome 抓取/反爬/PDF 解析)挂到我们服务器 /read 前缀,
 * 不调用其 listen(避免抢占端口)。
 */

export interface JinaReaderBridge {
  /** jina koa app 回调,直接以 (req, res) 调用 */
  handler(req: unknown, res: unknown): void;
}

export async function createJinaReaderBridge(config: Config): Promise<JinaReaderBridge> {
  const crawlModule = require(path.join(config.jinaApp, 'build/stand-alone/crawl.js')) as {
    default: {
      serviceReady(): Promise<unknown>;
      koaApp: {
        callback(): (req: unknown, res: unknown) => void;
      };
    };
  };
  const server = crawlModule.default;
  await server.serviceReady();
  const koaApp = server.koaApp;
  return {
    handler: (req, res) => {
      koaApp.callback()(req, res);
    },
  };
}
