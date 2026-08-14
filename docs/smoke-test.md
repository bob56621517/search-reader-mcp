# 冒烟测试流程

宿主单测 `npm test` 覆盖 HTTP 契约(search 路由、参数钳制、错误),但 `read/`、`mcp/`、`sse/` 依赖 jina 镜像运行时(Chrome 抓取、MCP 传输握手),需在**容器内冒烟**验证。以下按本次实测流程记录。

## 前置

- Docker daemon 运行;宿主环境变量 `BOCHA_API_KEY` 已有值(容器透传)
- 宿主端口 18081 空闲

## 流程

### 1. 构建镜像

```bash
docker build -t search-reader-mcp .
```

### 2. 启动容器

```bash
docker rm -f srm 2>/dev/null
docker run -d --name srm -p 18081:18081 -e BOCHA_API_KEY -e PORT=18081 search-reader-mcp
```

### 3. 等待就绪

Chrome 初始化需数秒(本机约 9s)。轮询 health:

```bash
for i in $(seq 1 20); do sleep 3; code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18081/health 2>/dev/null); [ "$code" = "200" ] && break; done; echo "health=$code"
```

### 4. 冒烟各端点(断言要点)

| 端点 | 断言 |
| --- | --- |
| `GET /s/<中文query>?count=2` | 200;`summary` 非空 + `webPages[]` 数组 |
| `GET /search/web/<query>?count=2` | 200;`webPages[]`(标题/链接/站点/摘要) |
| `GET /r/http://example.com` | 200;Markdown 正文;**URL Source 无 `?url=` 污染** |
| `POST /mcp`(initialize, JSON-RPC) | `serverInfo: search-reader-mcp`;**响应带 `Mcp-Session-Id`** |
| `GET /sse` | `event: endpoint` + `data: /messages?sessionId=...` |

中文 query 注意 URL 编码:浏览器会自动编码;curl 需手动 `encodeURIComponent`。

### 5. MCP 工具调用(可选)

验证 `read` 与 `search` 工具端到端:

```bash
node scripts/mcp-smoke.mjs            # 默认 http://localhost:18081
node scripts/mcp-smoke.mjs http://host:port
```

断言:`tools/list` 返回 `search`/`read`;`read` 工具返回目标页 Markdown(URL Source 干净);`search` 工具返回编号网页列表。

### 6. 清理

```bash
docker rm -f srm
```

## 常见问题

- **容器秒退 / `Cannot find module '/app/sleep'`**:镜像 `ENTRYPOINT` 是 `node`;跑临时容器需 `--entrypoint /bin/sleep`(且注意 Git Bash 的路径转换,加 `MSYS_NO_PATHCONV=1`)。
- **`/sse` 无响应**:确认 `SSEServerTransport` 显式 `await tx.start()`(McpServer.connect 不会自动调)。
- **MCP 无 `Mcp-Session-Id`**:确认 transport 使用 `sessionIdGenerator`(非 `undefined`,否则是无状态模式)。
