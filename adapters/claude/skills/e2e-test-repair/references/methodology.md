# E2E 测试规格方法论 v1

## 原则

### 1. Outside-in

从 Actor、Goal、关键旅程和业务结果出发。不在 E2E 层测试内部实现细节。

### 2. 风险驱动

只选择跨边界、失败代价高、下层测试不能充分证明的路径。高风险路径必须有显式覆盖或结构化 waiver。

### 3. Specification by Example

抽象验收条件必须落到具体可判定例子。没有可判定例子的 AC 不能进入 E2E 矩阵。

### 4. 最小充分路径

明确哪些规则应下沉 unit/integration/contract。不在 E2E 层重复证明下层已充分覆盖的路径。

### 5. 可观察性优先

oracle 面向用户或业务可观察结果，含允许时延和负面副作用。不依赖 CSS 选择器、函数调用栈或数据库内部行作为唯一 oracle。

### 6. 隔离与可恢复

身份、数据、环境、并发、重跑、清理、中断清理和补偿显式化。共享固定账号/数据且无并行隔离是不允许的。

### 7. 证据先行

规格阶段声明 runner、trace/log/report 和证明条件。不事后补证据。

### 8. 追溯闭环

case 连接 feature/AC/scenario、实现候选和 proof 状态。无绑定的 case 是伪 E2E。

## 工作流拓扑

```
inspect → assess → design → compose → review-core → repair-core → reconcile → validate
```

- **inspect**: 读取输入源（PRD、scenario、已有制品），提取业务上下文。
- **assess**: 运行候选判定，筛选进入 E2E 的路径，记录下沉项。
- **design**: 构建八维矩阵，为每个 case 填充所有维度。
- **compose**: 确定性渲染为 artifact.e2e-test@1 制品。
- **review-core**: 结构/contract/方法论审阅，输出 Review Result。
- **repair-core**: 修复 safe-fix finding，业务选择返回 NEEDS_INPUT。
- **reconcile**: proof 调和，绑定 runner、实现和证据。
- **validate**: 最终 contract 校验和 gate 检查。

## 阶段结果信封

每个阶段输出标准化的 stage result envelope：

```json
{
  "stage": "<stage-name>",
  "status": "PASS | FAIL | NEEDS_INPUT | BLOCKED",
  "inputs": { "...": "..." },
  "outputs": { "...": "..." },
  "findings": [],
  "duration_ms": 0
}
```

## 方法独立性

本方法论不依赖 `flow-architect`、`glaf4-test` 或 `loop-agent` 的领域方法。所有候选判定、矩阵设计、审阅规则和 proof 调和均为 E2E 测试规格领域原创。
