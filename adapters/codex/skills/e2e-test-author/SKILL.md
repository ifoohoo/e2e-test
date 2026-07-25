---
name: e2e-test-author
description: E2E 规格编制技能。通过 service-runner.mjs 完成 Registry preflight 与业务 dispatch。
---

# e2e-test-author

## 触发条件

用户请求编制 E2E 测试规格、从 PRD/scenario 生成 E2E 制品、或明确使用 `e2e-test-author`。

## 必读资源

- `references/methodology.md` — E2E 方法论 8 原则
- `references/candidate-assessment.md` — C1-C4 候选判定
- `references/matrix-model.md` — 八维矩阵模型
- `references/findings-catalog.md` — E2E-F-001 至 E2E-F-012
- `references/proof-reconciliation.md` — proof 调和模型
- `schemas/*.json` — 所有中间工件 schema

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 根据用户授权准备 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/service-runner.mjs" --request <request.json> --json`。
   service-runner 在同一次调用中完成 Registry preflight 与业务 dispatch。
3. 首次 request 最小字段：
   - `service`: `"author"`
   - `host`: `"codex"` 或 `"claude-code"`
   - `projectRoot`: 隔离项目绝对路径
   - `binding`: Registry producer 生成的完整 v2-binding（含 familyId、apiIdentity、implementationIdentity、providerSelector、authorization、conformanceEvidence）
   - `installation`: `{ packageDigest, provenance }`
   - `projectFacts`: Registry/Assistant producer 生成且摘要有效的完整 ProjectFactsEvidenceEnvelope；禁止手写不完整 envelope
   - `authorization`: `{ sideEffectBudget: "write-authorized-artifacts", granted: true }`，表示允许形成预览；不等于允许提交
   - `writeSet`: 制品、矩阵伴生文件、制品包 manifest 三个精确相对路径
   - `output`: 主制品路径（相对 projectRoot）；另外两个路径由同 basename 派生为 `.matrix.json` 与 `.package.json`
   - 原始编制使用 `rawInputs: { schemaVersion: 1, goal, sources, context? }`
   - 已有中间工件恢复使用 `inputs: { inspection, assessment, matrix }`；运行时会复验 schema、交叉引用、来源字节摘要并从 `compose` 恢复，不得直接写制品
4. 第一次调用只建立隔离 run root，返回 `AUTHOR_STAGE_READY`、`runId`、当前 `stage` 和 `nextAction`，项目零写入。
5. 严格按 `nextAction.stage` 继续调用。模型工序提交 `stageOutput`，确定性工序不得由调用方伪造输出。完整链为：
   ```
   inspect → assess → design → compose → review-core → repair-core → reconcile → validate
   ```
6. `validate` 通过只返回 `AUTHOR_PREVIEW_READY`：包含三项 `plannedWrites`、阶段链摘要、输入/提供方/API/contract/bundle/write-set 绑定和一次性 `commitHandle`；仍为项目零写入。
7. 向用户展示预览并取得明确提交授权后，才以 `mode: "commit"`、`commit: { runId, handleId }`、同一 `writeSet` 和 `authorization.granted: true` 再次调用。秘密只保存在本机 run root，不进入命令输出或对话。
8. 最终成功必须检查 `AUTHOR_COMPLETE`、`runLock.filesystemReverified: true` 和实际 `writeSet`。handle 重放、绑定漂移、路径漂移或目标已存在但未授权覆盖时必须阻断。
9. 缺少业务选择、目标 write set、可靠来源、项目拓扑/身份/runner 等关键输入时，返回 `NEEDS_INPUT`。

## 权限

- 默认预览：任何 author 形态（原始输入或中间工件恢复）都先输出预览，用户确认后才落盘。
- 只有用户明确授权且目标路径在 write set 内时才能写正式制品。
- 写前验证 Registry binding、side-effect budget、用户授权和 write set。
- 不复制 `flow-architect`、`glaf4-test` 或 `loop-agent` 的领域方法。
- 不允许直接调用 stage 脚本绕过 service-runner。

## 契约符合性指引（validate 硬门禁）

- 编制 assess 候选时，若原始输入含 scenario 来源（如 `raw/scenario.md`），必须为每个被选入矩阵的候选声明 `scenario_ref` 指向该 scenario 来源：`compose` 只从 `candidates[*].scenario_ref` 生成 `derives_from` 关系，而 artifact-graph 契约 `artifact.e2e-test@1` 要求制品至少包含一个 `derives_from` 关系；缺 `scenario_ref` 会使 `validate` 以 `RELATION_BELOW_MIN` 判 `ARTIFACT_CONTRACT_INVALID`，链无法完成。
- 契约对关系数量设有上限（MAX），编制时必须把数量约束在上限内：`artifact.e2e-test@1` 要求 `verifies`≤5、`implemented_by`≤5、`derives_from`≤10。`compose` 按被选入矩阵的候选 1:1 生成 `verifies`（并按 `scenario_ref` 1:1 生成 `derives_from`），按 design 编制的测试用例 1:1 生成 `implemented_by`。因此 **assess 选入矩阵的候选数与 design 编制的测试用例数都不得超过 5**；超过会使 `validate` 以 `RELATION_ABOVE_MAX` 判 `ARTIFACT_CONTRACT_INVALID`，链无法完成。
- 当来源 AC 或候选较多时，必须在 assess/design 阶段合并共享同一 feature+AC 的候选、把选入矩阵的候选与测试用例控制在 5 以内，而不是 authored 超出上限后再让 `validate` 阻断。这是数量合同，不得通过拆分制品或伪造关系计数规避。
- `validate` 的 artifact-graph 契约校验是硬门禁，不得绕过或弱化。出现契约违反时修正模型工序输出本身（补全 assess 候选的 `scenario_ref` 等来源声明、把候选/用例数收敛到契约上限内）后重跑，不得伪造制品字段。

## 业务质量与 proof 完整性

以下反模式来自实际 trial 和 recovery 诊断，作者 skill 必须避免：

1. **non_goals 不得写入验证范围内的来源约束。** 如果 AC 明确要求某来源必须被 trace，不得把该来源约束写入 non_goals 来规避实现。non_goals 只放真正不做的事项。
2. **case 覆盖多个 AC 时，proof / source_trace 不得丢失其中任何部分。** 一个 case 同时覆盖 AC-1 和 AC-3 时，proof 必须分别给出两个 AC 的证据，不得只证明其中一个。
3. **不得用自然语言说明冒充具体 runner / 测试入口。** "可以通过 X 验证" 的自然语言描述不等于具体可执行的 runner 命令或测试文件路径。proof 必须指向具体入口。
4. **只有 glob inventory 没有具体实现文件时，必须诚实表达可执行性与 proof 状态。** 如果仅通过 glob 确认文件存在但未读取内容、未运行测试，proof 必须标注为 inventory-level 而非 execution-level，不得声称已验证。
5. **matrix、artifact、proof 之间的逐 case 关系不得漂移。** matrix 中列出的每个 case 必须在 artifact 中有对应条目，每个条目必须有对应的 proof；不得出现 matrix 有但 artifact 缺失、或 artifact 有但 proof 缺失的情况。

## 输出合同

- 预览完成：`AUTHOR_PREVIEW_READY` + `artifact.e2e-test@1`、八维矩阵和制品包 manifest 三件套预览；项目零写入。
- 提交成功：`AUTHOR_COMPLETE` + 同一预览绑定的三件套正式文件。
- `NEEDS_INPUT`：缺少业务输入，列出所需字段和原因。
- `BLOCKED`：未启用或权限不足。
- 顶层输出遵循 service response 合同，其中 `stageResult` 遵循 `schemas/stage-result.json`。
