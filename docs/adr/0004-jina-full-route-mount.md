# ADR-0004: Jina 全量路由挂载

`/read/**` 全量透传给 jina 原生路由(任意 method,`/r` 完全同义):`/read` → jina `/`、`/read/<rest>` → `/<rest>`,`POST /read`(无尾路径)即原生文件上传解析(multipart `file` → Markdown)。改写 `req.url` 时保留原始 query string;全局 bodyParser 按 Content-Type 分流,不吞 `/read/**` 的 multipart body。我们 `/`、`/health` 为本服务 health,`/read/**` 专属 jina。原因是"扩展 jina 镜像"定位要求对 jina 的 read 能力保持原汁原味(上传解析、SPA POST、引擎控制头),且维持单端口整合。实现沿用 `handleRead` 手动改写 `req.url` 模式,不引入 koa-mount。
