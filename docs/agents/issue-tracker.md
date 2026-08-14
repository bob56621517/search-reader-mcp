# Issue 跟踪器:本地 Markdown

本仓库的 issue 和 spec(即 PRD)以 markdown 文件形式存放在 `.scratch/` 下。

## 约定

- 每个功能一个目录:`.scratch/<feature-slug>/`
- spec 位于 `.scratch/<feature-slug>/spec.md`
- 实现 issue 每个 ticket 一个文件:`.scratch/<feature-slug>/issues/<NN>-<slug>.md`,从 `01` 开始编号——绝不合并成一个 tickets 文件
- Triage 状态以 `Status:` 行记录在每个 issue 文件靠近顶部的位置(角色字符串见 `triage-labels.md`)
- 评论和对话历史以 `## Comments` 标题追加到文件底部

## 当技能"发布到 issue 跟踪器"时

在 `.scratch/<feature-slug>/` 下新建文件(必要时创建目录)。

## 当技能"获取相关 ticket"时

读取所引用路径的文件。用户通常会直接传入路径或 issue 编号。

## Wayfinding 操作

由 `/wayfinder` 使用。**map** 是一个文件,每个**子 ticket** 对应一个文件。

- **Map**:`.scratch/<effort>/map.md` — Notes / Decisions-so-far / Fog 正文。
- **子 ticket**:`.scratch/<effort>/issues/NN-<slug>.md`,从 `01` 编号,问题写在正文。`Type:` 行记录 ticket 类型(`research`/`prototype`/`grilling`/`task`);`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**:靠近顶部的位置记录 `Blocked by: NN, NN` 行。当该行列出的每个文件都已 `resolved` 时,ticket 解除阻塞。
- **Frontier**:扫描 `.scratch/<effort>/issues/` 查找开放、未阻塞、未认领的文件;编号小的优先。
- **认领**:任何工作开始前设置 `Status: claimed` 并保存。
- **解决**:在 `## Answer` 标题下追加答案,设置 `Status: resolved`,然后向 `map.md` 的 Decisions-so-far 追加上下文指针(gist + 链接)。
