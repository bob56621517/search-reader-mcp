# 02 — client 全量(核心代理 + 生命周期)

**What to build:** 本地 stdio MCP 完整可用——暴露 `search`/`read` 两工具,代理整合服务器的 HTTP API(统一走 POST);`read` 支持本地文件绝对路径;管理容器生命周期(检测 / 静默启动 / 失败语义,常驻不回收)。

**Blocked by:** 01

**Status:** ready-for-agent

- [x] 启动时从 `/catalog` 拉取 search/read 的 desc/hints(ADR-0009),inputSchema 由本地 zod 定义(`search` 镜像整合服务器参数;`read` 为 `{uri, skip, length, engine, timeout}`)
- [x] `search` → `POST /search/<type>` JSON body;`read` http(s) → `POST /read/<url>`(选项入 body)
- [x] `read` 本地文件(`file:///` 绝对 URI / 绝对 OS 路径)→ 读取后 multipart `POST /read` 上传解析;相对路径 → 返回指令文本不解析(ADR-0010);`skip`/`length` 本地切片
- [x] 生命周期:`/health` 探测命中 → 复用;未运行且 docker 可用 + `REQUIRED_ENVS` 齐备 → 静默后台 `docker run`(GHCR 镜像 v0.3.0,常驻);缺前置 → 启动失败退出、工具不注册;窗口期 → 工具返回"容器正在启动"状态;运行时容器挂 → 返回"容器未运行"指令文本(ADR-0011)
- [x] 主接缝测试:MCP 协议边界(server HTTP 与 docker 在注入点打桩),覆盖上述全部行为

## Comments

2026-08-18(T2 实施完成,commit 见 `dev-0.3.0` 分支 worktree):client 全量实现并测试通过。
- client/src 模块:catalog 拉取(降级默认 desc)、server-http 边界(fetch 注入)、docker 边界(spawn 注入)、lifecycle 状态机(health→docker run 容错 name in use→窗口期轮询)、zod schema、sliceText 契约副本、本地文件 uri 分类(ADR-0010)、search 格式化契约副本。
- 生命周期语义(ADR-0011):health 命中即复用;docker info + REQUIRED_ENVS(`[BOCHA_API_KEY]`)齐备才静默启动;缺前置 stderr 报错退出、工具不注册;docker run 拉镜像超时(124)转为后台观察不判失败;starting 超启动窗口转 down。
- 测试 27 项全绿:local-file/slice 纯逻辑 + lifecycle 进程内单测 + mcp-seam 主接缝(官方 Client 经 stdio 连真实 client,假 http server + 假 docker 脚本打桩,覆盖 catalog desc / search+read 代理 / 本地文件上传 / 相对路径指令 / 窗口期 / 运行时挂 / 启动失败退出)。
- CI test job 纳入 client npm ci + npm test(双产出物门禁)。
