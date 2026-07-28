# compose stage

确定性渲染为 artifact.e2e-test@1 制品（Markdown/JSON）。

## 输入

- `e2e-test-matrix.json` from design stage

## 输出

- artifact.e2e-test@1 制品（符合 Artifact Contract schema）
- stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- 制品必须包含 Artifact Contract 要求的所有 semantic markers：scope、system_boundary、coverage、environment_data、test_cases、evidence_contract。
- 制品必须包含至少 2 个 relation（derives_from 和 verifies）。
- test_cases 中的 case_id、path_class 等必须与矩阵一致。
- 不得生成 Artifact Contract schema 中未声明的额外字段。
