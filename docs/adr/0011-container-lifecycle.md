# ADR-0011: 容器生命周期(检测/静默启动/启动失败语义,常驻不回收)

client 不把容器当临时子进程,而是当常驻基础设施,只做"检测 + 条件满足时静默启动",**不做回收**(回收是未来容器内功能)。流程:① `GET :18081/health` 命中即复用,静默 ready;② 未运行且 docker 可用且 `REQUIRED_ENVS`(当前 `[BOCHA_API_KEY]`,可扩展列表)齐备 → 后台 `docker run -d` 拉取 GHCR 镜像(`ghcr.io/bob56621517/search-reader-mcp:v0.3.0`,`--restart unless-stopped`,卷 `~/.search_reader_mcp`),启动窗口期后台轮询 /health、工具调用返回"容器正在启动,可手动 docker pull"状态文本;③ 前置条件缺失(无 docker / 缺必填 env)→ **client 启动失败**:按正常 MCP 失败路径退出、工具不注册。运行时容器挂掉 → 工具调用返回"容器未运行"指令文本(ADR-0007),不自动重启。早期方案(client 自动启停 + 退出时回收自己启动的容器)存在所有权判定与崩溃泄漏 bug,故废弃——容器一旦由任何一方启动即常驻,后续 session 复用。
