# E2E Finding Catalog

稳定 finding 规则 E2E-F-001 至 E2E-F-012。

权威来源：`design-e2e-test-skill-family-and-multi-family-governance.md` 第 13 节。

每条 finding 包含 rule、severity、artifact/case 定位、evidence、expected、actual、repairability、suggestion 和 rule source。业务判断不确定时标记 `NEEDS_INPUT`，不能伪装成确定违规。

---

## E2E-F-001: 来源 feature/AC/scenario 缺失或不可达

| 字段 | 值 |
|------|---|
| rule | E2E-F-001 |
| severity | high |
| category | traceability |
| description | 测试用例缺少来源 feature、验收条件或 scenario 的声明，或声明的来源制品不可达 |
| evidence | case.source_artifact / source_ac / source_scenario 字段 |
| expected | 每个 case 至少引用一个可达的 feature/AC/scenario |
| actual | 来源缺失或引用不可达 |
| repairability | safe-fix |
| suggestion | 补充来源引用或修正不可达的制品路径 |
| rule source | 权威设计 §13 E2E-F-001 |

---

## E2E-F-002: 非 E2E 候选，应该下沉到单元/集成/契约测试

| 字段 | 值 |
|------|---|
| rule | E2E-F-002 |
| severity | high |
| category | candidate |
| description | 测试路径不满足任何 E2E 候选条件（C1-C4），应下沉到 unit/integration/contract 测试 |
| evidence | 候选评估记录 criteria_met |
| expected | 至少满足跨边界、核心价值旅程、真实协同风险或证明性需求之一 |
| actual | 无条件满足 |
| repairability | safe-fix |
| suggestion | 记录为下沉项，移至对应的 unit/integration/contract 测试 |
| rule source | 权威设计 §13 E2E-F-002 |

---

## E2E-F-003: Actor、Goal、业务价值或系统边界不清

| 字段 | 值 |
|------|---|
| rule | E2E-F-003 |
| severity | high |
| category | context |
| description | 测试用例缺少清晰的 Actor 声明、业务 Goal、价值描述或系统边界定义 |
| evidence | inspection.business_context / matrix.value_risk / matrix.source_scope 字段 |
| expected | Actor、Goal、业务价值和系统边界均有明确定义 |
| actual | 至少一项缺失或模糊 |
| repairability | safe-fix |
| suggestion | 补充 Actor、Goal、价值和边界声明 |
| rule source | 权威设计 §13 E2E-F-003 |

---

## E2E-F-004: 关键路径或高风险异常/恢复路径缺失且无 waiver

| 字段 | 值 |
|------|---|
| rule | E2E-F-004 |
| severity | high |
| category | coverage |
| description | 矩阵中缺少关键 happy path，或缺少高风险 error/recovery/security 路径且无结构化 waiver |
| evidence | matrix path_class 分析 + waiver 检查 |
| expected | 关键 happy path 有覆盖；高风险路径缺失时有结构化 waiver |
| actual | 关键路径缺失或高风险路径无覆盖且无 waiver |
| repairability | business-decision |
| suggestion | 补充路径覆盖或提供结构化业务决策 waiver |
| rule source | 权威设计 §13 E2E-F-004 |

---

## E2E-F-005: oracle 不可观察、依赖实现细节或没有时延语义

| 字段 | 值 |
|------|---|
| rule | E2E-F-005 |
| severity | high |
| category | oracle |
| description | Oracle 依赖 CSS 选择器、函数调用栈、数据库内部行或特定实现细节，无业务可观察结果或缺少时延语义 |
| evidence | oracle.observable / oracle.criterion 字段 |
| expected | 面向用户或业务可观察结果，含允许时延和负面副作用 |
| actual | 依赖实现内部细节或无时延语义 |
| repairability | safe-fix |
| suggestion | 将 oracle 改为业务可观察结果（API 响应、UI 状态、消息队列消息等），补充时延声明 |
| rule source | 权威设计 §13 E2E-F-005 |

---

## E2E-F-006: 数据、身份、并行隔离或重复运行策略缺失

| 字段 | 值 |
|------|---|
| rule | E2E-F-006 |
| severity | medium |
| category | isolation |
| description | 使用共享固定账号或数据且无并行隔离策略，或重复运行策略缺失 |
| evidence | data_identity 字段 |
| expected | 每个 case 有独立数据、身份隔离和重复运行策略 |
| actual | 共享固定账号/数据且无缓解，或重跑策略未声明 |
| repairability | safe-fix |
| suggestion | 引入唯一测试身份或数据分区，声明重复运行策略 |
| rule source | 权威设计 §13 E2E-F-006 |

---

## E2E-F-007: 清理、失败中断清理或补偿策略缺失

| 字段 | 值 |
|------|---|
| rule | E2E-F-007 |
| severity | medium |
| category | cleanup |
| description | 测试用例缺少正常清理、失败中断清理或补偿策略 |
| evidence | cleanup 字段 |
| expected | 有正常清理步骤、失败中断清理和补偿策略 |
| actual | 清理、失败中断清理或补偿策略缺失 |
| repairability | safe-fix |
| suggestion | 添加正常清理、失败中断清理和补偿策略 |
| rule source | 权威设计 §13 E2E-F-007 |

---

## E2E-F-008: runner/实现绑定缺失、重复、被 ignore 或不在 inventory

| 字段 | 值 |
|------|---|
| rule | E2E-F-008 |
| severity | high |
| category | proof |
| description | 测试用例的 runner/实现绑定缺失、重复声明、被 runner ignore/skip，或不在 runner inventory 中 |
| evidence | automation.runner / automation.implementation_binding / proof binding 字段 |
| expected | runner 存在且在 inventory 中，实现绑定唯一且有效 |
| actual | 绑定缺失、重复、被 ignore 或不在 inventory |
| repairability | business-decision |
| suggestion | 确认 runner 状态；补充或修正实现绑定 |
| rule source | 权威设计 §13 E2E-F-008 |

---

## E2E-F-009: 证据合同不足，无法证明执行结论

| 字段 | 值 |
|------|---|
| rule | E2E-F-009 |
| severity | high |
| category | evidence |
| description | 证据合同（trace、log、report）不足以证明测试执行结论 |
| evidence | automation.trace_report / automation.proof_condition / evidence 字段 |
| expected | 有充分的 trace/log/report 证据证明执行结论 |
| actual | 证据不足或缺失 |
| repairability | safe-fix |
| suggestion | 补充 trace/log/report 证据或修正证明条件 |
| rule source | 权威设计 §13 E2E-F-009 |

---

## E2E-F-010: 高脆弱性、高成本或不稳定等待未被控制

| 字段 | 值 |
|------|---|
| rule | E2E-F-010 |
| severity | medium |
| category | stability |
| description | 测试用例存在高脆弱性（如依赖特定时序）、高执行成本或不稳定等待（如 sleep），且未被控制 |
| evidence | 稳定性分析 / 执行成本声明 |
| expected | 脆弱性、成本和等待被显式控制或缓解 |
| actual | 高脆弱性/高成本/不稳定等待未控制 |
| repairability | safe-fix |
| suggestion | 引入重试、超时、事件驱动等待或成本控制策略 |
| rule source | 权威设计 §13 E2E-F-010 |

---

## E2E-F-011: Markdown 与 matrix/runtime schema 不一致

| 字段 | 值 |
|------|---|
| rule | E2E-F-011 |
| severity | medium |
| category | consistency |
| description | 最终 Markdown 制品与八维矩阵或 runtime schema 不一致，存在字段缺失、值不同步或结构偏差 |
| evidence | Markdown 制品与 matrix/runtime schema 对比 |
| expected | Markdown 制品与 matrix/runtime schema 完全一致 |
| actual | 字段缺失或值不同步 |
| repairability | safe-fix |
| suggestion | 重新从 matrix 确定性渲染 Markdown 制品 |
| rule source | 权威设计 §13 E2E-F-011 |

---

## E2E-F-012: proof、traceability 或 version lock 陈旧

| 字段 | 值 |
|------|---|
| rule | E2E-F-012 |
| severity | medium |
| category | proof |
| description | proof 指向的实现/配置已变更、traceability 链断裂或 version lock 已过期 |
| evidence | proof binding digest / traceability 链 / version lock 状态 |
| expected | proof、traceability 和 version lock 均为当前状态 |
| actual | 陈旧或不匹配 |
| repairability | out-of-scope |
| suggestion | 由外部 runner 或 artifact-graph 维护流程重新生成证据并刷新 version lock；本技能族不自动执行 |
| rule source | 权威设计 §13 E2E-F-012 |
