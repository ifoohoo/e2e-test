---
name: e2e-test-author
description: E2E 规格编制技能。当前为 fail-closed contract placeholder，返回 NOT_IMPLEMENTED。
---

# e2e-test-author

## 目的

E2E 规格编制服务（`artifact.e2e-test.author`）。当前处于 Gate A，为 fail-closed contract placeholder。

## 约束

- 不创建项目文件。
- 不生成任何制品。
- 不加载第三方实现。
- 不调用 registry fallback。
- 不暗示已符合正式 Family API 的 author service 签名。

## 行为

收到任何调用时，确定性运行：

1. 从当前 `SKILL.md` 的绝对路径向上两级解析 `PLUGIN_ROOT`。
2. 运行 `node "$PLUGIN_ROOT/scripts/gate-status.mjs" --service author --json`。

输出结构化 JSON 并使用非零退出码。

## 输出

```json
{
  "service": "author",
  "status": "not-implemented",
  "reason": "NOT_IMPLEMENTED",
  "message": "e2e-test-author 尚未实现。此服务的目标行为：接受 artifact.context-packet@1 和 user.requirement@1，产出 artifact.e2e-test@1 制品。当前 Gate A 状态下不提供此能力。"
}
```
