---
name: e2e-test
description: E2E 测试技能族默认入口。按明确 intent 路由到 help/author/review/repair，不复制各服务协议。
---

# e2e-test

## 触发条件

用户使用 `e2e-test` 或请求 E2E 测试相关操作但未指定具体服务。

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. help intent 直接转交 `e2e-test-help`；其他 intent 先准备完整 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/service-runner.mjs" --request <request.json> --json`。
3. service-runner 在同一次调用中完成目标服务的 Registry preflight 与业务 dispatch；调用方检查最终业务码和 `runLock.filesystemReverified: true`，不得把内部 preflight 状态当作业务完成。
4. 当 intent 为 author/review/repair 时，default 仅做意图识别并将请求转交目标服务，目标服务必须重新经过自己的 Registry 查询和授权；default 的 read-only ceiling 不得授权写操作。
5. 按用户 intent 路由：

| intent | 路由目标 | 成功码 | sideEffectCeiling |
|--------|---------|--------|-------------------|
| help / 诊断 | e2e-test-help | `HELP_READY` | read-only |
| author / 编制 / 生成 | e2e-test-author | `AUTHOR_PREVIEW_READY` → 明确提交后 `AUTHOR_COMPLETE` | write-authorized-artifacts |
| review / 审阅 | e2e-test-review | `REVIEW_COMPLETE` | write-review-result |
| repair / 修复 | e2e-test-repair | `REPAIR_PREVIEW_READY` → 明确提交后 `REPAIR_COMPLETE` | write-authorized-artifacts |
| 不明确 | 输出帮助信息，建议使用 e2e-test-help | — | read-only |

## 权限

- 只按明确 intent 路由，不复制 author/review/repair 协议。
- 未绑定时返回 `NOT_ENABLED`，不尝试自动创建 binding。
- author/repair 默认预览；default 不得把一次意图识别当作提交授权。
- 不允许直接调用 stage-runner 或 stage 脚本绕过 service-runner。

## 输出合同

- 未绑定/未启用时输出 `BLOCKED` + `NOT_ENABLED` 结构化 JSON。
- 路由成功时将控制权交给目标服务，由目标服务的 Registry 链验证授权。
- 成功时 runLock.filesystemReverified 必须为 true。
