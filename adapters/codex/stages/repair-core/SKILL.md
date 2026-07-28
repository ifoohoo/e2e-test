---
name: e2e-test-stage-repair-core
description: 仅供 E2E repair/author 内部编排按 Review Result 执行安全修复；不是用户入口。
---

# Repair Core 内部工序

只允许能力清单中 `repairability: safe-fix` 且存在 `repairHandler` 的规则自动修复。当前仅 F005 和 F007 有确定性修复器。

业务决策、外部维护和无 handler 的 finding 必须返回 NEEDS_INPUT；不得扩大写集、降低门禁、伪造证据或删除问题对象。修复计划必须明确到 finding 与 case。

交付给 `workers/repair-core-worker.mjs`，其输出仍只进入 run root，后续必须重新 review 和 validate。
