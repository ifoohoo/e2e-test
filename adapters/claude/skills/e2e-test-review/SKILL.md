---
name: e2e-test-review
description: E2E 规格审阅技能。通过 service-runner.mjs 完成 Registry preflight 与业务 dispatch。
---

# e2e-test-review

## 触发条件

用户请求审阅 E2E 规格、检查 E2E 制品质量、或明确使用 `e2e-test-review`。

## 必读资源

- `references/findings-catalog.md` — E2E-F-001 至 E2E-F-012 稳定规则
- `references/methodology.md` — E2E 方法论
- `schemas/review-result.json` — Review Result schema
- `schemas/stage-result.json` — stage result 信封

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 准备含 host、exact family binding、installation/project facts 与 `write-review-result` 授权的 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/service-runner.mjs" --request <request.json> --json`。
   service-runner 在同一次调用中完成 Registry preflight 与业务 dispatch。
3. request 最小字段：
   - `service`: `"review"`
   - `host`: `"codex"` 或 `"claude-code"`
   - `projectRoot`: 隔离项目绝对路径
   - `binding`/`installation`/`projectFacts`: 使用 Registry/Assistant producer 的完整证据，同 author
   - `authorization`: `{ sideEffectBudget: "write-review-result", granted: true }`
   - `inputArtifact`: 待审阅制品相对路径
   - `output`（可选）: Review Result 输出路径，需在 writeSet 中
4. 成功必须检查 `REVIEW_COMPLETE` 且 `runLock.filesystemReverified: true`。
5. 业务 dispatch 执行：
   ```
   contract-validate → semantic-review (Finding 生成)
   ```
6. review-core 对制品执行结构校验与 Finding 生成。

## 权限

- 对输入制品只读；即使选择 stdout-only，Registry 仍按 Family API 的 `write-review-result` 服务上限授权。
- 只消费 `artifact.e2e-test@1` 制品。
- 不复制 `flow-architect` 或 `glaf4-test` 的审阅方法。
- 不允许直接调用 stage 脚本绕过 service-runner。

## 输出合同

- 成功：`REVIEW_COMPLETE` + schema-valid Review Result JSON，含 findings、severity、repairability。
- `NEEDS_INPUT`：制品缺少必要字段，无法审阅。
- `BLOCKED`：未启用或权限不足。
- 负例稳定产生指定 `E2E-F-*` finding。

## 特殊识别能力

- 当前确定性实现包括：只有 happy path（E2E-F-004）、不可观察 oracle（E2E-F-005）、无中断清理（E2E-F-007）、runner ignore/unscoped（E2E-F-008）、证据缺失（E2E-F-009）、陈旧 proof（E2E-F-012）等；以 `assets/finding-capability-manifest.json` 为唯一能力事实。
- E2E-F-002、E2E-F-006、E2E-F-010 当前为 `planned`，不得声称已能稳定识别；任一 planned 规则都会阻断 family 宣称 stable。
