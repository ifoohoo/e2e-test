---
name: e2e-test-review
description: E2E 规格审阅技能。当前为 fail-closed contract placeholder，返回 NOT_IMPLEMENTED。
---

# e2e-test-review

## 目的

E2E 规格审阅服务（`artifact.e2e-test.review`）。当前处于 Gate A，为 fail-closed contract placeholder。

## 约束

- 不创建、修改或删除任何文件。
- 不生成 Review Result。
- 不加载第三方实现。
- 不调用 registry fallback。
- 不暗示已符合正式 Family API 的 review service 签名。

## 行为

收到任何调用时，确定性运行：

1. 从当前 `SKILL.md` 的绝对路径向上两级解析 `PLUGIN_ROOT`。
2. 运行 `node "$PLUGIN_ROOT/scripts/gate-status.mjs" --service review --json`。

输出结构化 JSON 并使用非零退出码。

## 输出

```json
{
  "service": "review",
  "status": "not-implemented",
  "reason": "NOT_IMPLEMENTED",
  "message": "e2e-test-review 尚未实现。此服务的目标行为：接受 artifact.e2e-test@1，产出 artifact.review-result@1。副作用上限: read-only, write-run-evidence。当前 Gate A 状态下不提供此能力。"
}
```
