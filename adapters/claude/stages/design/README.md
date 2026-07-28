# design stage

构建八维矩阵，为每个 case 填充所有必需维度。

## 输入

- `candidate-assessment.json` from assess stage

## 输出

- `e2e-test-matrix.json` — 八维矩阵，author/review/repair 共用的权威中间模型（schema: `schemas/matrix.json`）
- stage result envelope（schema: `schemas/stage-result.json`）

## 八维

1. 价值与风险 (value_risk)
2. 来源与范围 (source_scope)
3. 路径 (path)
4. Oracle (oracle)
5. 数据与身份 (data_identity)
6. 环境与依赖 (environment)
7. 清理与恢复 (cleanup)
8. 自动化与证据 (automation)

## 确定性规则

- 八个维度全部必填，不得用空字符串或 N/A 逃逸。
- 高风险异常/恢复路径缺失时必须有结构化 waiver。
- Oracle 必须面向业务可观察结果，不依赖 CSS/函数/数据库内部。
- 每个 case 必须有 isolation 策略，且三类清理（正常 cleanup_steps、失败 failure_cleanup、补偿 compensation）均须非空。
