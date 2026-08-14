# 路线图(Next Steps)

后续迭代计划,按优先级排列。实现时可直接据此排期。

## 1. 优化 search 工具描述

优化 MCP `search` 工具的 `description`,更精确地引导模型使用:默认 `ai` 语义搜索的适用场景、何时显式切 `type="web"`、以及 `type`/`freshness`/`include`/`exclude` 各参数的语义与边界,提升工具被正确调用的质量。

## 2. 重构 read 工具描述

重构 MCP `read` 工具的 `description`,对齐 read 能力形态(路径即 url):明确输入(`http/https` URL)、输出(Markdown 正文)、当前限制(仅网络 URL),并为后续本地文件支持预留描述空间。

## 3. read 工具支持缓存

sqlite 缓存基础设施已建库(先建库不接缓存,`src/cache/sqlite.ts`)。接入 read:按 URL 缓存抓取后的 Markdown 结果,命中直接返回缓存,减少重复抓取(Chrome 渲染最贵)。需定义:缓存键、TTL、失效策略。

## 4. read 工具支持本地文件

在 `url`(http/https)基础上支持本地文件读取 → Markdown。单容器场景下 `file://` 语义 = 读容器内/挂载目录的文件(如 compose 外挂卷内的文档);需定义 scheme(`file://`)与路径映射、支持的格式(文本/PDF/Office)。
