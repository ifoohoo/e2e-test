---
name: e2e-test-stage-reconcile
description: 仅供 E2E author/review 内部编排把制品包、实现、runner inventory 与执行证据调和为 proof 五态；不是用户入口。
---

# Reconcile 内部工序

本工序完全确定性。按 `planned → candidate-linked → implementation-bound → evidence-bound` 推导；任一来源、实现、runner、证据、摘要或 version lock 漂移进入 `stale`。

候选存在不能越级为实现或证据绑定；实现必须在 inventory 内唯一且活跃；ignored、skipped、unscoped 不得成为 evidence-bound；proof 只单向绑定 package manifest。

调用 `workers/reconcile-worker.mjs`，方法细节见 `references/proof-reconciliation.md`。
