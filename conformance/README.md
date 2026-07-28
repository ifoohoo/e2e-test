# Conformance

本目录用于存放 Gate B deterministic conformance 和 behavior qualification 证据。

## 确定性 Conformance

运行 `node scripts/conformance-runner.mjs --json` 获取 conformance 报告。

验证内容：
- implementation descriptor 结构和 digest
- API/contract revision digest 固定
- schemas 完整且合法
- fixtures 正负例有效性
- findings catalog 完整性
- references 完整性
- adapter 无漂移
- 默认未启用

## Behavior Qualification

behavior qualification 需要在目标宿主（Codex/Claude）中实际运行，验证：
1. 两宿主都能加载 help/default/author/review/repair
2. author 正例产生 contract-valid 制品
3. 非 E2E 候选被下沉
4. review 负例产生预期 findings
5. repair 只修复 safe finding
6. fail closed 边界

当前状态：NOT_RUN（需要目标宿主环境）。
