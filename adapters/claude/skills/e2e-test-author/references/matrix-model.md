# 八维矩阵模型

## 概述

每个 E2E 测试用例必须在以下八个维度上完整定义。高风险异常/恢复路径缺失时必须有结构化 waiver，不得用空字符串、`N/A` 或 prose 注释逃逸。

## 维度定义

### 1. 价值与风险 (value_risk)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| business_value | string | 是 | 此 case 保护的业务价值 |
| risk_level | enum | 是 | critical / high / medium / low |
| failure_impact | string | 是 | 失败时对业务的影响 |
| waiver | object | 否 | 结构化 waiver（当风险路径未覆盖时） |

### 2. 来源与范围 (source_scope)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source_artifact | string | 是 | 来源制品 ID |
| acceptance_criteria | string[] | 是 | 覆盖的验收条件 |
| scope_boundaries | string[] | 是 | 本 case 的边界声明 |

### 3. 路径 (path)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path_class | enum | 是 | happy / error / recovery / edge / security / performance |
| steps | string[] | 是 | 关键步骤序列 |
| cross_boundary | string[] | 是 | 跨越的边界列表 |

### 4. Oracle (oracle)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| observable | string | 是 | 业务可观察结果 |
| criterion | string | 是 | 判定标准 |
| negative_check | string | 否 | 负面结果检查 |
| timeout_ms | integer | 是 | 允许时延；必填且 minimum 1（机器门禁以 timeout_ms 为 truthy 时延判定，缺失或为 0 即 finding） |

### 5. 数据与身份 (data_identity)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| test_data | string[] | 是 | 测试数据声明 |
| identities | string[] | 是 | 测试身份声明 |
| isolation | string | 是 | 并行隔离策略 |
| shared_state | string | 否 | 共享状态说明和隔离缓解 |

### 6. 环境与依赖 (environment)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| topology | string | 是 | 部署拓扑 |
| external_deps | string[] | 是 | 外部依赖 |
| setup | string[] | 是 | 环境准备步骤 |

### 7. 清理与恢复 (cleanup)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cleanup_steps | string[] | 是 | 正常清理步骤（非空） |
| failure_cleanup | string[] | 是 | 失败时中断清理步骤（非空） |
| compensation | string[] | 是 | 副作用发生后的反向操作（退款、释放、回滚）（非空） |
| idempotent | boolean | 是 | 是否可安全重跑 |

三类清理数组（cleanup_steps、failure_cleanup、compensation）均须至少含一个非空字符串；空数组或空字符串会被机器门禁判定为 normal/failure/compensation cleanup incomplete（E2E-F-007）。

恢复确定性（WP1D）：每一种故障注入必须**分别**绑定确定性恢复动作、恢复健康检查与恢复后 oracle。恢复/清理文本不得出现“若曾注入故障则恢复”“注入过则恢复”这类以历史是否注入为条件的写法——`workers/design-worker.mjs` 会机械检测并失败关闭（E2E-F-007）。恢复动作必须无条件、可重复执行。

### 8. 自动化与证据 (automation)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| runner | string | 是 | 测试执行器；优先逐字复制项目 runner inventory 的规范标识。运行时仅在大小写折叠后唯一命中时提供互操作保护，歧义必须失败关闭，不支持任意别名。 |
| trace_report | string | 是 | trace/log/report 产出声明 |
| proof_condition | string | 是 | 证明条件 |
| implementation_binding | string | 是 | 实现绑定声明；validate 要求每个 active case 有实现绑定且 runner 逐字命中 project-facts inventory，否则 E2E-F-008 high |

## Waiver 规则

当高风险路径（error/recovery/security）缺失覆盖时，必须提供结构化 waiver：

```json
{
  "reason": "缺少此路径的具体原因",
  "risk_acceptance": "接受此风险的业务决策",
  "reviewer": "决策审批人",
  "expires": "waiver 过期日期"
}
```

空 waiver 不允许。缺失高风险路径且无 waiver 的 case 不得通过审阅。
