# Schema Negative Fixtures

这些负例只破坏一个 JSON Schema 或 Artifact Contract 约束。
测试断言"只因预期层级和规则失败"。

| 文件 | Schema | 预期失败 |
|------|--------|----------|
| inspection-missing-context.json | inspection.json | missing required `business_context` |
| candidate-no-criteria.json | candidate-assessment.json | `criteria_met` empty (minItems: 1) |
| matrix-missing-dimension.json | matrix.json | missing required `cleanup`/`automation` |
| artifact-no-relations.json | artifact.e2e-test@1 | insufficient relations (contract) |
