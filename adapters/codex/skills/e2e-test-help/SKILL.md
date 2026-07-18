---
name: e2e-test-help
description: 只读诊断入口，输出 E2E 测试技能族的 Gate 状态、能力清单、依赖/兼容前置、最小示例、下一步和诊断信息。
---

# e2e-test-help

## 目的

只读、零项目写入的诊断入口。确定性运行 `gate-status.mjs --json`，输出当前版本、Gate A 状态、依赖/兼容前置、能力清单、最小示例、下一步和诊断信息。

## 约束

- 只读：不得创建、修改或删除任何项目文件。
- 不得调用 registry、不查询 provider、不解析 sources/bindings。
- 不得进入领域 workflow。

## 行为

1. 从当前 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 运行 `node "$PLUGIN_ROOT/scripts/gate-status.mjs" --json`。
3. 解析输出并格式化为可读诊断报告。
4. 明确告知用户：author/review/repair 尚不可执行。

## 输出格式

```text
E2E Test Skill Family v0.1.0 (Gate A)

Gate A 状态: {passed|failed}
依赖前置:
  - Artifact Contract: artifact.e2e-test@1 (draft, not registered)
  - Family API: artifact.e2e-test-family@1 (draft, not registered)
  - Registry: not bound (no provider catalog)

能力清单:
  [OK] e2e-test-help — 只读诊断
  [FAIL-CLOSED] e2e-test — 默认入口 (GATE_B_REQUIRED)
  [FAIL-CLOSED] e2e-test-author — 未实现
  [FAIL-CLOSED] e2e-test-review — 未实现
  [FAIL-CLOSED] e2e-test-repair — 未实现

最小示例:
  $e2e-test-help        # 查看本诊断
  $e2e-test --help      # 返回 GATE_B_REQUIRED

下一步:
  Gate B 前需要完成 Artifact Contract、Family API、registry 身份分离、
  deterministic conformance 和最小 behavior qualification。
  详见 CHANGELOG.md 了解当前能力和已知限制。

诊断:
  版本: {version}
  实现 descriptor: {implPath}
  adapter codex: {codexStatus}
  adapter claude: {claudeStatus}
```
