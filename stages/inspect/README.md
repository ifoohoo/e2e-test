# inspect stage

读取输入源（PRD、scenario、已有制品），提取业务上下文和候选路径。

## 输入

- PRD feature artifact 或用户需求描述
- scenario script artifact
- 已有 E2E 制品（如有）

## 输出

- `inspection.json` — 结构化业务上下文和候选路径提取结果（schema: `schemas/inspection.json`）
- stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- 必须提取 business_goal、actors、key_journeys。
- 必须列出所有候选路径及其边界。
- 缺少关键输入时返回 `NEEDS_INPUT`。
