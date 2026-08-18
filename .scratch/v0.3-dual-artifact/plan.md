# v0.3 双产出物 · 实施计划

**日期**:2026-08-18(grill-with-docs 定稿)
**分支**:`dev-0.3.0`(当前 checkout);全部功能完成才合入 main
**决策来源**:`docs/adr/0008-0011` + `CONTEXT.md`;本文件只列实施顺序与清单。

---

## 阶段 0:仓库重构(server/ + client/)

- [ ] `git mv src test scripts` → `server/`;`Dockerfile`、`docker-compose.yml` → `server/`(compose 改名 `compose.yml`)
- [ ] 修正相对路径:server/Dockerfile(build context)、server/compose.yml、server/scripts/mcp-smoke.mjs、server/test/、server/package.json scripts
- [ ] 新建 `client/` 骨架:package.json、tsconfig、src/、test/(独立 Node 项目,依赖 @modelcontextprotocol/sdk + zod)
- [ ] 更新 CI `.github/workflows/docker-image.yml`:job 先 `cd server` 再 `npm ci && npm test`;build context 指 `server/`
- [ ] 版本升 0.3.0:server/package.json + client/package.json + server/src/mcp/server.ts 的 McpServer version

## 阶段 1:server 功能

- [ ] `GET /catalog`:复用 `buildMcpDesc` 的 desc,返回 `{tools:[{name, description, annotations}]}`;annotations 四项显式(含 `destructiveHint:false`)
- [ ] MCP 工具补 hint:`server/src/mcp/server.ts` 的 search/read 加 `destructiveHint:false`(补全 OpenAI 目录要求)
- [ ] `handleRead`:`POST /read/<rest>` 也接入 read_cache(GET/POST 等价,见 ADR-0004 + jina 契约;key 用 url+engine)
- [ ] 测试:server/test 补 `/catalog` 契约、POST 读缓存

## 阶段 2:client

- [ ] 启动流程(ADR-0011):`GET :18081/health` 命中 → 复用;未命中 → `docker info` + `REQUIRED_ENVS`(`[BOCHA_API_KEY]`)齐备 → 后台 `docker run -d --name search-reader-mcp --restart unless-stopped -p 18081:18081 -e BOCHA_API_KEY -v ~/.search_reader_mcp:/app/extension/data ghcr.io/bob56621517/search-reader-mcp:v0.3.0`;缺失 → stderr 报错并退出(工具不注册)。容错:name in use → `docker start`;启动后回探 /health
- [ ] 工具定义:启动时拉 `/catalog` 拿 desc/hints;本地 zod schema(search 镜像 server 参数 `{type,query,count,freshness,include,exclude}`;read `{uri,skip,length,engine,timeout}`)
- [ ] read handler:http(s) → `POST /read/<url>`;file:/// 绝对 URI / 绝对 OS 路径 → 读文件 → `POST /read` multipart 上传;相对路径 → 指令文本(ADR-0010);skip/length 本地切片
- [ ] search handler:`POST /search/<type>` JSON body
- [ ] 窗口期 / 运行时失败:返回"正在启动 / docker pull"状态、或"容器未运行"指令文本(ADR-0007)
- [ ] 测试:client/test,MCP 协议层(Client→真实 client,server 用假 HTTP 边界/假 docker 命令)

## 阶段 3:收口

- [ ] README 手册化(双产出物 + 快速开始:client 一条命令、缺配置时的启动失败提示)
- [ ] smoke-test 更新(client 冒烟替代 server /mcp 冒烟为主)
- [ ] security-review(本地文件读取原语,ADR-0010)
- [ ] 合入 main 前 code-review(Spec/Standards 双轴)
