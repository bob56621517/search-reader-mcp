# Domain 文档

工程技能在探索代码库时如何消费本仓库的 domain 文档。

## 探索前先读这些

- 仓库根目录的 **`CONTEXT.md`**,或
- 若存在仓库根目录的 **`CONTEXT-MAP.md`** — 它指向每个 context 各自的 `CONTEXT.md`。阅读与当前主题相关的每一个。
- **`docs/adr/`** — 阅读与你即将工作的区域相关的 ADR。

如果这些文件都不存在,**静默继续**。不要提示它们缺失,也不要主动建议提前创建。`/domain-modeling` 技能(通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 触达)会在术语或决策真正被确定时惰性创建它们。

## 文件结构

Single-context 仓库(大多数仓库):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## 使用术语表的词汇

当你的输出提到某个 domain 概念(在 issue 标题、重构提案、假设、测试名中)时,使用 `CONTEXT.md` 中定义的那个词。不要漂移到术语表明确避免的同义词。

如果你需要的概念还不在术语表中,这是一个信号——要么你在发明项目不用的语言(重新考虑),要么存在真实缺口(记下留给 `/domain-modeling`)。

## 标注 ADR 冲突

如果你的输出与已有 ADR 冲突,显式指出来而不是静默覆盖:

> _与 ADR-0007(事件溯源订单)冲突——但值得重新开启,因为…_
