---
name: e2e-test-repair
description: E2E 规格修复技能。通过 service-runner.mjs 完成 Registry preflight 与业务 dispatch。
---

# e2e-test-repair

## 触发条件

用户请求修复 E2E 规格中的 finding、或明确使用 `e2e-test-repair`。

## 必读资源

- `references/findings-catalog.md` — E2E-F-001 至 E2E-F-012
- `references/methodology.md` — E2E 方法论
- `schemas/review-result.json` — Review Result schema
- `schemas/stage-result.json` — stage result 信封

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 准备含 host、exact family binding、installation/project facts、授权与 write set 的 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/service-runner.mjs" --request <request.json> --json`。
   service-runner 在同一次调用中完成 Registry preflight 与业务 dispatch。
3. request 最小字段：
   - `service`: `"repair"`
   - `host`: `"codex"` 或 `"claude-code"`
   - `projectRoot`: 隔离项目绝对路径
   - `binding`/`installation`/`projectFacts`: 使用 Registry/Assistant producer 的完整证据，同 author
   - `authorization`: `{ sideEffectBudget: "write-authorized-artifacts", granted: true }`
   - `inputArtifact`: 待修复制品相对路径
   - `output`: 修复后制品输出路径（需在 writeSet 中）
   - `reviewResult`（可选）: Review Result 文件相对路径
   - `repairPlan`: `{ "<rule>": { ...fixFields } }` 修复计划
4. 首次修复成功只返回 `REPAIR_PREVIEW_READY`、一次性 `commitHandle` 和 planned write；项目零写入。
5. 向用户展示差异并取得明确授权后，以 `mode: "commit"`、`commit: { runId, handleId }`、同一 `writeSet` 再次调用；最终检查 `REPAIR_COMPLETE` 和 `runLock.filesystemReverified: true`。
6. business-decision 或尚未实现 handler 的 finding 返回 `REPAIR_NEEDS_INPUT`，零写入。
7. 业务 dispatch 执行：
   ```
   safe-fix → contract-validate → re-review
   ```

## 权限

- 只消费有效 Review Result 中的 open finding。
- 只修 safe 且在授权 write set 内的项。
- 不得通过删除关系、waiver、用例或降低门禁来"修绿"。
- 预览前验证 Registry binding 与 side-effect budget；提交前再次验证用户授权、一次性 handle、输入/提供方/API/contract/bundle 绑定和 write set。
- 不允许直接调用 stage 脚本绕过 service-runner。

## 输出合同

- 预览完成：`REPAIR_PREVIEW_READY` + 修复后制品预览与重审结果，零写入。
- 提交成功：`REPAIR_COMPLETE` + 与预览完全相同的修复制品。
- `REPAIR_NEEDS_INPUT`：business-decision finding 需要用户输入，零写入。
- `BLOCKED`：未启用或权限不足。
