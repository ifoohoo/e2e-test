---
name: e2e-test
description: E2E 测试技能族默认入口。当前为 fail-closed contract placeholder，返回 GATE_B_REQUIRED。
---

# e2e-test

## 目的

E2E 测试技能族的默认入口。当前处于 Gate A，为 fail-closed contract placeholder。

## 约束

- 不创建项目文件。
- 不加载第三方实现。
- 不调用 registry fallback。
- 不暗示已符合正式 API 或已能设计高质量 E2E。

## 行为

收到任何调用时，确定性运行：

1. 从当前 `SKILL.md` 的绝对路径向上两级解析 `PLUGIN_ROOT`。
2. 运行 `node "$PLUGIN_ROOT/scripts/gate-status.mjs" --service default --json`。

输出结构化 JSON 并使用非零退出码。

## 输出

```json
{
  "service": "default",
  "status": "fail-closed",
  "reason": "GATE_B_REQUIRED",
  "message": "当前 e2e-test 技能族处于 Gate A（独立仓库骨架）。默认入口尚未实现。author/review/repair 均为 fail-closed placeholder。"
}
```
