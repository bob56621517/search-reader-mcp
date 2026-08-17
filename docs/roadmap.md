# 路线图(Next Steps)

后续迭代计划,按优先级排列。实现时可直接据此排期。

> 一期增强(全量路由挂载 + read 缓存 + MCP read/search 工具 + 描述 env 化 + README 手册化)已作为进行中的任务,见 `.scratch/search-reader-mcp/v7-read-cache-mcp.md`,不再列入路线图。

## 0. 国际化,和规划

当前主流大模型要么英语母语要么中英双语. 因此,在文档和 mcp tool desc上 提供部署选项,支持中英双语  
代码合规问题,移除无效配置问题  

## 1. 搜索引擎抽象

提供一个搜索引擎的抽象层,或者深度开发 jina原本自带的 搜索引擎provider,用于支持更多的搜索引擎  

## 2. 无mcp,纯skill

提供一个 skill, 指导 agent 直接 启动 docker, 使用 rest api 而不是 mcp服务,降低token 消耗和对环境的依赖

## 3. claudecode 插件化
