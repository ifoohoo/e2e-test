# e2e-test

实验性 E2E 测试专业技能族 — 框架中立的 E2E 规格编制、审阅、修复和证明调和。

## 状态

**Gate A（骨架）** — 实验性技能族，正在开发中。

- `e2e-test-help`：只读诊断入口。可用。
- `e2e-test`、`e2e-test-author`、`e2e-test-review`、`e2e-test-repair`：fail-closed 合约占位。未实现。
- 无 provider catalog。默认不启用。
- 不替代 `artifact-chain-assistant` 通用 `e2e`。

## 安装

```bash
npm install e2e-test
```

详细安装说明请参见 [INSTALL.md](INSTALL.md)。

## 快速开始

```bash
# 查看 Gate A 状态
node scripts/gate-status.mjs --json
```

## 架构

本技能族遵守 `artifact-chain-assistant` 定义的 E2E Test Skill Family API：

- 符合 Artifact Contract `artifact.e2e-test@1`（草案）
- 实现 Family API `artifact.e2e-test-family@1`（草案）
- 默认整族原子绑定（无 mixSafe）
- 成熟度：experimental

## 许可证

Apache-2.0
