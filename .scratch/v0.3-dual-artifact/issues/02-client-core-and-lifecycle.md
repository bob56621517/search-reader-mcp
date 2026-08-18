# 02 — client 全量(核心代理 + 生命周期)

**What to build:** 本地 stdio MCP 完整可用——暴露 `search`/`read` 两工具,代理整合服务器的 HTTP API(统一走 POST);`read` 支持本地文件绝对路径;管理容器生命周期(检测 / 静默启动 / 失败语义,常驻不回收)。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 启动时从 `/catalog` 拉取 search/read 的 desc/hints(ADR-0009),inputSchema 由本地 zod 定义(`search` 镜像整合服务器参数;`read` 为 `{uri, skip, length, engine, timeout}`)
- [ ] `search` → `POST /search/<type>` JSON body;`read` http(s) → `POST /read/<url>`(选项入 body)
- [ ] `read` 本地文件(`file:///` 绝对 URI / 绝对 OS 路径)→ 读取后 multipart `POST /read` 上传解析;相对路径 → 返回指令文本不解析(ADR-0010);`skip`/`length` 本地切片
- [ ] 生命周期:`/health` 探测命中 → 复用;未运行且 docker 可用 + `REQUIRED_ENVS` 齐备 → 静默后台 `docker run`(GHCR 镜像 v0.3.0,常驻);缺前置 → 启动失败退出、工具不注册;窗口期 → 工具返回"容器正在启动"状态;运行时容器挂 → 返回"容器未运行"指令文本(ADR-0011)
- [ ] 主接缝测试:MCP 协议边界(server HTTP 与 docker 在注入点打桩),覆盖上述全部行为
