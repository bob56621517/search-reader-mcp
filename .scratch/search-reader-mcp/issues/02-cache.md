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

## 执行流程(并行协议)

本 ticket 按以下并行协议执行(基线分支 `feat/v7-read-cache-mcp`):

1. **阻塞检查(先于创建分支)**:执行前先读本 ticket 的 `Blocked by`(依赖 **01-config**)。若依赖未完成(`Status` 非 `resolved`),先提示用户"01-config 未完成(阻塞本任务),是否先执行?";确认后先执行阻塞任务,完成后再回到本任务。
2. **创建 worktree + 分支**:阻塞解除后,在**当前项目目录内**创建隔离工作区与任务分支:
   `git worktree add -b feat/v7/02-cache feat/v7-read-cache-mcp ./src-02-cache`
3. **实现**:按本 ticket 实现要点完成,单测通过。
4. **合并回基线**:`git merge --no-ff` 合并回 `feat/v7-read-cache-mcp`;同文件冲突(多 ticket 改同一文件)由后合并者解决;完成后更新本 ticket `Status: resolved`。
5. **全部完成后**:协调会话将基线统一合并进 `main`(期间不逐个合 main)。
6. **push 与交接**:任务中断或用户走开时,显式 push 到远端同名分支(`origin/feat/v7-read-cache-mcp`、`origin/feat/v7/02-cache`);跨会话/中断时按需留交接文档。
