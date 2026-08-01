---
name: e2e-test-stage-design
description: 仅供 E2E author 内部编排把候选设计成 E2E 八维测试矩阵；不是用户入口。
---

# Design 内部工序

为每个候选独立设计 Actor/Goal、价值风险、来源范围、路径与边界、Oracle、数据身份、环境依赖、清理补偿、自动化证据八个维度。完整字段模型见 `../../references/matrix-model.md`。

Oracle 必须是用户或业务可观察结果，包含判据和时延；数据必须说明并行隔离与重跑；清理必须覆盖正常、失败中断和补偿；自动化必须说明 runner、证据、成本与抖动控制。

机器门禁提示（与 `../../schemas/matrix.json` 一致）：三类清理数组（正常 cleanup_steps、失败 failure_cleanup、补偿 compensation）均须非空，不得用空数组或空字符串逃逸；`oracle.timeout_ms` 必填且 ≥1；`automation.implementation_binding` 为 validate 硬门禁：validate 要求每个 active case 有实现绑定且 runner 逐字命中 project-facts inventory，否则 E2E-F-008 high。

`automation.runner` 必须优先逐字复制项目 runner inventory 的规范标识，不要把标识改写成展示名称。运行时只对大小写折叠后唯一命中的标识提供互操作保护；歧义或任意别名必须失败关闭。

实现绑定诚实性（WP1E）：`automation.implementation_binding` 应指向受 active runner inventory 管辖的**具体实现文件**（来自 `project-facts.runnerInventory[].files`），不要把 inventory 的发现范围 glob 当成具体文件。若只声明 glob，运行时会用 inventory 具体文件事实解析；inventory 无对应具体文件时只能诚实降级为非 implementation-bound（`glob_only`），具体文件越界 inventory 时同样降级（`out_of_scope`）。glob 冒充具体文件会被失败关闭（E2E-F-008）。

至少包含关键 happy path，以及 error/recovery/security 路径；缺失时只能提供结构化 waiver 或返回业务决策输入。输出符合 `../../schemas/matrix.json`，交付给 `../../workers/design-worker.mjs`。

## 逐 case 终检清单（WP1D）

每个 case 交付前必须逐条自检；可机械检查的部分由 `workers/design-worker.mjs` 失败关闭，其余由本清单与试验 prompt 合同约束：

1. **唯一可判定预期**：goal 中的每个业务结果都必须落在一个唯一、可判定的 `oracle.criterion` 中得到证明。除非来源明确允许多种终态，否则不得用“A 或 B”“可借或分配给下一位”这类二选一写法逃避唯一预期；若来源确有多终态，必须把每个终态各自的判定条件写清楚，而不是放任不确定。
2. **逐故障确定性恢复**：每一种故障注入必须**分别**绑定三件事——确定性恢复动作（`cleanup.failure_cleanup`/`compensation`）、恢复健康检查、恢复后 oracle。不得用“若曾注入故障则恢复”“注入过则恢复”这类以历史是否注入为条件的写法替代；恢复动作必须无条件、可重复执行（`idempotent=true`）。
3. **恢复后 oracle**：recovery/error case 必须有一个证明系统已回到确定健康态的 oracle，而不是只断言故障被注入。
