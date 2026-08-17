# ADR-0007: 报错即 prompt

对不可达资源(非 `http(s)` scheme、无可用抓取能力),MCP read 工具不返回生硬的"仅支持 http/https"式报错,而是返回**自包含的提示词模板**:引导 agent 自行下载资源后经 `POST /read` 上传解析,逐项解释 curl 参数(方法 / 端点 / `file` 字段 / `x-engine` / `x-retain-links` / `x-retain-images`),端点地址从 `SERVER_URL` env 渲染(默认 `http://localhost:18081`),参数对齐 MCP 暴露的功能。原因是 LLM 拿到指引文本可直接执行下一步(下载 + 上传),而不是卡住或依赖外部文档;模板内联地址与参数,避免硬编码与二次查找。上传解析行为与其对齐:默认保留全部链接/图片 URL、不递归嵌套解析。
