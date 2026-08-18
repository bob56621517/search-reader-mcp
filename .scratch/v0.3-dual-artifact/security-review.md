# v0.3 security-review 记录

**日期:** 2026-08-18
**范围:** 本地文件读取原语(ADR-0010 安全边界)及相关安全面(server 不读宿主文件 ADR-0007、容器生命周期 ADR-0011、catalog、search、MCP hint 合规)
**结论:** 通过(含 1 项安全改进:client 启动容器端口绑定 127.0.0.1)

---

## 1. 本地文件读取原语(ADR-0010)— `client/src/local-file.ts` + `client/src/tools.ts`

| 审查项 | 结论 |
| --- | --- |
| 只接受绝对路径:`file:///` 绝对 URI 或绝对 OS 路径;相对路径返回指令文本不解析 | ✅ 消除"相对哪个目录"歧义与工作目录错读面(`classifyUri` → `relative` 拒) |
| `file://host`(如 `file://relative/x`)归 `invalid` | ✅ 避免被当作 UNC/网络路径的歧义 |
| `fileURLToPath` 失败(非法编码等)归 `invalid` | ✅ try/catch 兜底 |
| 无白名单目录:安全边界 = MCP host 权限层 + OS 权限兜底 | ✅ 设计决策(agent 显式调用即授权,OS 可拒绝),见 ADR-0010 |
| 读取失败(不存在/无权限)返回可读错误文本,不泄漏堆栈 | ✅ `读取失败:${e.message}` |
| 文件内容外发:仅发往配置的 `SERVER_URL`(默认 `localhost:18081`);容器仅绑定 127.0.0.1(见下) | ✅ 默认最小面 |
| 文件名仅传 `path.basename`(multipart),不泄漏路径 | ✅ |
| 大文件读取无大小限额 | ⚠️ spec Out of Scope 明确「上传鉴权/大小限额(沿用现状)」;agent 显式调用,MCP host 权限层可约束 |

**结论:符合 ADR-0010,未发现缺陷。**

## 2. server 不读宿主文件(ADR-0007)— `server/src/server.ts`

| 审查项 | 结论 |
| --- | --- |
| server 容器不挂敏感宿主路径(仅数据卷 `~/.search_reader_mcp`) | ✅ |
| read 非 http(s) uri 返回上传引导模板,不抓取本地路径 | ✅ |
| server 把 path 当 URL 交 jina,jina 仅抓 http(s);无本地文件访问 | ✅ 路径穿越面 = 0(与 ADR-0007 一致) |
| 上传解析:bodyParser 放行 multipart,交 jina;文件内容内存处理、上传不缓存 | ✅ |

**结论:维持 ADR-0007,通过。**

## 3. 容器生命周期(ADR-0011)— `client/src/lifecycle.ts` + `client/src/docker.ts`

| 审查项 | 结论 |
| --- | --- |
| docker run 参数均为内部常量(config),无外部命令注入;Windows shell 解析仅用于 docker 可执行文件 | ✅ |
| 常驻 `--restart unless-stopped`,client 退出不停容器;不自动重启 | ✅ ADR-0011 |
| **端口绑定 `-p 127.0.0.1:18081:18081`(仅本机)** | ✅ **本次改进**:原 `-p 18081:18081`(0.0.0.0)会把未认证的 read/search/mcp 端点暴露到网络;client 为本地基础设施,仅本机访问足够;远程直连走 compose(用户手动,0.0.0.0) |
| `BOCHA_API_KEY` 经 `-e` 透传容器;容器用其调 bocha API | ✅ 仅此一个敏感 env |
| 数据卷 `~/.search_reader_mcp` 可被容器读写(持久化设计) | ✅ 设计所需;镜像来自 GHCR(供应链信任,见遗留项) |
| 缺 docker / 缺 `REQUIRED_ENVS` → 启动失败退出,工具不注册 | ✅ ADR-0011 失败语义 |

**结论:通过(含本次端口绑定改进)。**

## 4. /catalog 与工具元数据(ADR-0009)

| 审查项 | 结论 |
| --- | --- |
| `GET /catalog` 返回 desc/hints 元数据,无敏感信息;非 GET 返回 405 | ✅ |
| client 启动拉取,失败回退本地内建默认(不阻塞) | ✅ |

**结论:通过。**

## 5. search

| 审查项 | 结论 |
| --- | --- |
| `POST /search/<type>` JSON body;`BOCHA_API_KEY` 在 server 端,不外泄 | ✅ |
| 错误返回可读文本,不泄漏内部细节 | ✅ |

**结论:通过。**

## 6. MCP 工具 hint 合规(OpenAI 目录)

`search`/`read` 四项 hint 全声明(`readOnlyHint:true` / `idempotentHint:true` / `openWorldHint:true` / `destructiveHint:false`),inputSchema 由 zod 声明;server `/mcp` 与 client stdio 两个 MCP 面均验证(冒烟脚本断言)。

**结论:通过。**

---

## 本次修复的改进

1. **client 启动容器端口绑定 `127.0.0.1`**(`client/src/lifecycle.ts`、`client/src/tools.ts` 恢复指令同步,`client/test/lifecycle.test.js` 断言更新):避免未认证端点暴露到 0.0.0.0。

## 遗留/边界(不在本次范围)

- 本地文件大小限额:spec Out of Scope 明确,沿用现状。
- 镜像供应链信任:`ghcr.io/bob56621517/search-reader-mcp:v0.3.0` 为项目自管 GHCR tag,信任假设成立。
- compose(`server/compose.yml`)仍绑定 `0.0.0.0`:远程直连场景的显式选择;本机使用可自行改 `127.0.0.1`。
