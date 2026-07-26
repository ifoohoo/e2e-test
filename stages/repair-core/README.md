# repair-core stage

修复 safe-fix finding，business-decision 返回 NEEDS_INPUT。

## 输入

- Review Result with open findings
- artifact.e2e-test@1 制品

## 输出

- 修复后的 artifact.e2e-test@1 制品
- 更新后的 Review Result
- stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- 只修复 repairability 为 safe-fix 的 finding。
- business-decision 的 finding 返回 `NEEDS_INPUT`，不自动修复。
- out-of-scope 的 finding 不处理。
- 不得通过删除关系、waiver、用例或降低门禁来"修绿"。
- 修复后必须重新运行 deterministic validate 和独立 re-review。
