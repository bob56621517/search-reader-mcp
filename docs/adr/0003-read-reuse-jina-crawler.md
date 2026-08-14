# ADR-0003: read 进程内复用 jina 抓取模块

`read/` 不独立实现爬取,而是进程内 require jina 编译产物(`build/stand-alone/crawl.js` 的 `CrawlStandAloneServer`),取其 `koaApp`(内含 CrawlerHost 驱动的 Chrome 抓取、反爬对抗、PDF 解析)作为中间件复用,不调用其 listen。原因是项目定位是"扩展 jina 镜像、复用其环境",而非重造爬虫。替代方案(用 puppeteer 独立实现)被否。代价:与 jina 内部模块耦合,镜像升级后需验证兼容性。
