---
name: e2e-test-stage-validate
description: 仅供 E2E 工作流内部执行最终 contract、round-trip、package manifest 与 proof 聚合门禁；不是用户入口。
---

# Validate 内部工序

本工序完全确定性，依次检查：最小 Artifact Contract、八维矩阵 round-trip、artifact/matrix/manifest 内容摘要、proof 状态推导、finding 严重度和写集边界。

任何高严重度 finding 使工序失败；非 evidence-bound 只能如实显示状态，不能渲染为通过。验证器不判断候选或 Oracle 的专业语义质量。

调用 `workers/validate-worker.mjs`；结果符合 `schemas/stage-result.json`，不得直接提交项目文件。
