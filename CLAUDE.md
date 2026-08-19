# search-reader-mcp

扩展 [Jina Reader](https://jina.ai/reader) 镜像的项目:在 Jina Reader 基础上添加自定义搜索与 MCP 服务。

## 项目形态

- **单服务**;发布形态为 `docker-compose` + `Dockerfile`,`server/compose.yml` 仅用于便捷启动
- 目标:扩展 Jina Reader 镜像,加入自定义搜索能力与 MCP 服务

## Agent skills

### Issue tracker

Issue 以 markdown 文件形式存放在仓库的 `.scratch/<feature-slug>/` 目录下。详见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范 triage 角色映射到标签 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context:`CONTEXT.md` + `docs/adr/` 位于仓库根目录。详见 `docs/agents/domain.md`。
