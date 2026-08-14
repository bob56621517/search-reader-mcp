# ADR-0002: search 独立实现,bocha 直连而非接入 SearcherHost

我们没有像 read 那样复用 jina 的搜索链路(把 bocha 作为新 provider 接入镜像的 `SearcherHost`),而是**独立实现** `search/` 路由,用内置 fetch 直接调 bocha 的 web-search / ai-search 两个 API,返回自定结构化 JSON。原因是用户希望 search 与镜像生态解耦、结果格式自定(并提供了本地参考实现 `xyz-mcp-hub` 的 `BochaClient` 作为照搬范本)。代价:结果格式与 jina 搜索生态不对齐,`SearcherHost` 的能力(重写、排序等)不复用。
