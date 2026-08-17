# ADR-0005: read 缓存接入

`read` 抓取结果用 sqlite 一级缓存:只缓存解析后的 markdown 全文,键 = `uri(含 query)+ engine`(联合唯一),TTL 默认 300s 滑动续期,惰性删除叠加每小时定时兜底清理,同键并发做 in-flight 去重。缓存层在 HTTP read 层(`handleRead`),HTTP 直连与 MCP self-call 共用;`POST /read` 上传解析不缓存;只缓存成功响应,失败/错误不写缓存。原因是 Chrome 渲染(全量抓取)最贵,按 URL 缓存可显著减少重复抓取,方向对齐官方 Jina Reader 对同一 URL 的 5 分钟缓存;键含 engine 避免不同抓取引擎结果互相串缓存(动态页 vs 静态页内容不同)。
