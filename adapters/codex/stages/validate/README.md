# validate stage

最终 contract 校验和 gate 检查。

## 输入

- artifact.e2e-test@1 制品
- `e2e-proof-binding.json`
- Review Result

## 输出

- 校验结果
- family stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- Artifact Contract 校验通过。
- 八维矩阵完整性通过。
- Proof binding 有效性通过。
- 无 open high-severity finding。
- 所有 relations 有效。
- 证据合同满足。
