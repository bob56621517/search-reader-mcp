# 01 — 仓库重构 + server 侧 v0.3 功能

**What to build:** 仓库从单产出物重构为双产出物(server 容器 + client 本地 stdio MCP);整合服务器新增工具目录端点 `/catalog`、MCP 工具合规(四项 hint + zod inputSchema)、`POST /read/<rest>` 接入 read 缓存。重构后 server 功能不变。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 仓库分为 `server/` 与 `client/` 两棵独立 Node 项目,互不跨树相对 import;`server/` 功能不变、全测试绿、镜像可构建;CI 与 Docker 构建 context 指向 `server/`;版本统一 0.3.0
- [ ] `GET /catalog` 返回 search/read 的 `name/description/annotations`(四项显式,含 `destructiveHint:false`),desc 复用整合服务器的 `MCP_*` env 化描述(ADR-0009)
- [ ] 整合服务器 MCP 的 search/read 四项 hint 全声明、inputSchema 由 zod 声明
- [ ] `POST /read/<rest>` 与 GET 等价接入 read 缓存(缓存 key 含 url + engine)(ADR-0004 + jina GET|POST 契约)
- [ ] 上述契约有自动化测试覆盖(HTTP 契约测试 + 冒烟脚本断言四项 hint)
