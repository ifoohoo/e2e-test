---
name: e2e-test-stage-review-core
description: 仅供 E2E review/author 内部编排执行确定性 finding 和受能力清单约束的语义审阅；不是用户入口。
---

# Review Core 内部工序

先执行 `assets/finding-capability-manifest.json` 中有真实 handler 的确定性规则，再执行 manifest 明确标为 `semantic-review` 的模型规则。当前标为 `planned` 的规则不得伪装成已审阅。

每条 finding 必须说明规则、严重度、描述、证据和修复属性；业务取舍返回 NEEDS_INPUT。不得以 checklist 存在替代语义审阅，也不得为了通过而删除关系、case 或 waiver。

模型语义 finding 通过 `stageOutput.semanticFindings` 交给 `workers/review-core-worker.mjs`；未获 manifest 授权的规则会 fail-closed。
