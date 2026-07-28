# review-core stage

结构/contract/方法论审阅，输出 Review Result Protocol v1.0。

## 输入

- artifact.e2e-test@1 制品
- `e2e-test-matrix.json`（可选，用于交叉校验）

## 输出

- Review Result（schema: `schemas/review-result.json`）
- `e2e-findings.json` — E2E-F-001~012 findings
- stage result envelope（schema: `schemas/stage-result.json`）

## 审阅维度

### 确定性校验

1. Artifact Contract schema 校验
2. semantic markers 校验
3. relation rules 校验
4. 八维矩阵完整性校验

### 方法论审阅

按 `references/findings-catalog.md` 的 E2E-F-001 至 E2E-F-012 规则逐条审阅。

## 确定性规则

- 确定性校验先于方法论审阅。
- 每个 finding 必须有 rule、severity、evidence、expected、actual、repairability 和 suggestion。
- 业务判断不确定时标记 `NEEDS_INPUT`，不能伪装成确定违规。
