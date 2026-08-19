# ADR-0009: /catalog 工具定义来源(desc/hints 从 server 流出,schema 由 client 自持)

server 新增 `GET /catalog`,返回工具定义**元数据**(`{tools:[{name, description, annotations}]}`);client 启动时拉取,desc 与 hints 的单一来源是 server(server 的 `MCP_*` env 可覆盖 desc,client 自动同步)。**inputSchema 不由 catalog 下发,由 client 本地 zod 定义**:因为 client 的 read 调用面与 server 不同(详见 ADR-0010,client 支持本地文件、server 不支持),schema 照搬会制造"两套 schema 谁真"的困惑。选 Option A 而非 B(返回完整工具定义)的理由:client 的调用面自己说了算,hints/inputSchema 的合规(OpenAI 目录要求四项 hint 全声明 + 每工具 zod)由 client 端保证,server 侧无需为此改造 schema 输出。

**read desc 的例外**:`search` 调用面两树相同,desc 严格单一来源 server(/catalog,`MCP_SEARCH_DESC` 可覆盖);`read` 因 client 调用面不同(ADR-0010:client 原生读取本地文件,server 描述的是上传引导),desc 由 **client 本地自持**(描述 file:/// 与绝对 OS 路径原生读取),不经 catalog 下发覆盖——若照搬 server 的 read desc(只讲"curl 上传引导")会误导 agent。`read` 的 hints 仍与 server 一致(四项全声明)。
