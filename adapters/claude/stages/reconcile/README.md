# reconcile stage

Proof 调和，绑定 runner、实现和证据。

## 输入

- artifact.e2e-test@1 制品
- 运行证据（如有）

## 输出

- `e2e-proof-binding.json` — proof 绑定（schema: `schemas/proof-binding.json`）
- stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- 所有 active case 必须有 proof binding（违反标记 E2E-F-008）。
- Proof 必须指向实际执行的测试，不得指向被 skip/ignore 的测试。
- 当实现文件或配置变更时，proof freshness 标记为 `stale`。
- 不得伪造 proof：复制旧 proof、修改失败变通过、删除绑定消除 finding。
