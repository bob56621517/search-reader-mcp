# 02 · read 缓存:read_cache 表 + 读写/续期/清理 + in-flight 去重

Type: task
Status: ready-for-agent
Blocked by: 01

## 目标

在 sqlite 缓存基础设施上接入 read 缓存:一级缓存(仅解析后 Markdown),键 = `uri(含 query)+ engine`,TTL 滑动续期,惰性删除 + 每小时定时兜底清理,in-flight 去重。

## 实现要点

- `read_cache` 表:`uri`、`engine`、`cache_path`、`expire_at`(epoch ms),`UNIQUE(uri, engine)`。
- 读写:get(命中校验 `expire_at`)、put(写缓存文件 + 记录索引)、命中后滑动续期。
- 清理:惰性(访问到过期即删重抓)+ 每小时定时兜底(删过期行 + 删缓存文件;仅按 `expire_at < now` 条件删,不误删并发新写入)。
- 只缓存成功结果;失败/错误不写。
- in-flight 去重:粒度 = 缓存键(`uri+engine`),同键并发共享进行中 Promise,完成后移除;不同 engine 不互相等待。
- TTL 来源:`config.readCacheTtl`(`READ_CACHE_TTL`)。

## 验收

- 单测:写入/命中/过期重抓/滑动续期/定时清理只删过期/in-flight 同键只抓一次。

## 依据

`.scratch/search-reader-mcp/spec.md`(缓存)、`v7-read-cache-mcp.md`(三)。
