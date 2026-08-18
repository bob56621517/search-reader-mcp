# 03 — 收口:手册化 + 冒烟 + 安全/代码审查

**What to build:** v0.3 交付物文档化与质检——README 双产出物手册、冒烟脚本以 client 为主更新、安全审查与代码审查,准备合入 main。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] README 手册化:快速开始(client 一条命令)、启动失败提示(缺 docker / 缺必填配置)、配置项、双产出物架构说明
- [ ] 冒烟脚本以 client 为主更新并全绿
- [ ] security-review 通过(本地文件读取原语,ADR-0010 安全边界)
- [ ] code-review(Spec/Standards 双轴)通过,确认全部功能完成后合入 main
