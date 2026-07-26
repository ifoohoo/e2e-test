# Proof 调和方法

## 概述

Proof 调和是连接 E2E 规格、实现和执行证据的追溯闭环。每个 E2E 测试用例的 proof 必须能追溯到：

1. 来源：feature / AC / scenario
2. 实现：代码文件、配置或脚本
3. 执行证据：runner trace、log、report

## Proof Binding 模型

```json
{
  "case_id": "TC-001",
  "artifact_id": "project:e2e-spec:TC-001",
  "source_trace": {
    "feature_id": "F-001",
    "ac_id": "AC-001",
    "ac_ids": ["AC-001", "AC-002"],
    "scenario_id": "S-001"
  },
  "implementation": {
    "files": ["tests/e2e/checkout.spec.ts"],
    "commit": "abc123",
    "runner": "playwright"
  },
  "evidence": {
    "last_run": "2026-07-19T00:00:00Z",
    "status": "passed",
    "report_path": "runs/e2e-test/TC-001/report.json",
    "report_digest": "sha256:..."
  },
  "binding_digest": "sha256:...",
  "freshness": "current | stale | missing"
}
```

## 调和规则

### PR-001: 所有 active case 必须有 proof binding

状态为 `active` 的测试用例必须有 proof binding。缺少 binding 的 case 标记为 E2E-F-008。

### PR-002: Proof 必须指向实际执行

proof 中的 runner 和 evidence 必须指向实际执行的测试，不得指向被 skip/ignore 的测试。违反标记为 E2E-F-008（runner/实现绑定被 ignore）。

### PR-002a: 实现绑定必须区分 glob、具体文件与执行证据（WP1E）

`implementation.files` 只能承载受对应 active runner inventory 管辖的**具体实现文件**，禁止通配符。inventory 的发现范围 glob 记录在 `implementation.discovery_glob`，与具体文件语义分离，不得伪装成具体文件：

- 模型声明具体文件且受 inventory 管辖 → 绑定该具体文件。
- 模型声明 glob → 由 inventory 的具体文件事实（`runnerInventory[].files`）解析出具体绑定；inventory 无对应具体文件时记 `glob_only=true`、`files=[]`，诚实降级为非 implementation-bound。
- 具体文件越界 active runner inventory → 记 `out_of_scope`、`files=[]`，诚实降级。
- `files` 含通配模式（glob 冒充具体文件）→ `validateProofBinding` 失败关闭产生 E2E-F-008。

以上任一降级 đều使 `proof_state` 落入 `stale/runner-unscoped`，绝不误报 implementation-bound。

### PR-003: Proof freshness

当实现文件或配置变更时，proof freshness 标记为 `stale`。超过阈值未更新的标记为 `missing`。

### PR-004: Proof 不得伪造

不得通过：
- 复制旧 proof 到新 case
- 修改 proof 使失败变通过
- 删除 proof 绑定来消除 finding

### PR-005: Reconcile 周期

每次 author/review/repair 后自动运行 reconcile，更新：
- 新增 case 的 proof binding
- 变更 case 的 freshness
- 移除 case 的 proof 清理

### PR-006: 复合 AC 必须全量追溯

`source_trace.ac_ids` 是规范化多值字段，必须逐 case 无损保留 `source_scope.acceptance_criteria` 的全部 AC；复合 AC case 禁止只保留 `acceptance_criteria[0]`。兼容单值 `ac_id` 保留为 `ac_ids[0]`。若 `ac_id` 与 `ac_ids` 不一致（被截断或越界），或 `ac_ids` 为空，reconcile/validate 失败关闭并产生 E2E-F-012。状态推导以 `ac_ids` 是否非空判定候选追溯完整性。

## Reconcile 输出

```json
{
  "reconcile_id": "RECONCILE-001",
  "timestamp": "2026-07-19T00:00:00Z",
  "total_cases": 10,
  "bound": 8,
  "unbound": 2,
  "stale": 1,
  "missing": 0,
  "findings": [
    {
      "rule": "E2E-F-008",
      "case_id": "TC-009",
      "detail": "runner/实现绑定缺失、重复、被 ignore 或不在 inventory"
    }
  ]
}
```
