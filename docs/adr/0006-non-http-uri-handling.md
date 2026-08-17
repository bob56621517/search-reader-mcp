# ADR-0006: 非 http(s) 资源处理策略 + timeout 体系

对非 `http(s)` 的 uri(file/ftp/s3/data 等),服务端**不实现任何下载协议**(曾考虑协议抽象层 + file/ftp 下载器,被否),一律返回提示词模板,引导 agent 自行在本地下载后经 `POST /read` 上传解析。原因是:在容器内为各类云存储配置 API 凭据重量级且不安全;不开放任意协议读取同时维持安全边界(容器可达性 = 任意文件读取/SSRF 面)。timeout 体系随之定为三层:jina 内部抓取(`x-timeout`,≤180s,软,透传)、HTTP 层整体(`X-Read-Timeout` header / env `READ_TIMEOUT`,硬,超时 504)、MCP 参数(`timeout`,≤600s,硬,超时返回可读错误文本);MCP timeout 语义统一为「加载 web + 解析」整体预算,并经 clamp-180 的 `x-timeout` 透传与 jina 内部预算对齐。
