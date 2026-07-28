---
name: e2e-test-stage-assess
description: 仅供 E2E author 内部编排执行候选判定和测试层下沉，产出 candidate-assessment DTO；不是用户入口。
---

# Assess 内部工序

只消费通过 inspect 校验的业务上下文。E2E 候选必须至少满足：跨边界、核心价值旅程、真实协同风险或证明性需求之一。

把适合单元、集成或契约测试的路径记录为 `downstream_items`，写清目标层与原因；不要为了扩大 E2E 覆盖把它包装为候选。

输出必须符合 `schemas/candidate-assessment.json`，且 `inspection_ref` 精确匹配前序结果。冲突来源或无法取舍的候选返回 `needs_input`。交付给 `workers/assess-worker.mjs`。
