# e2e-test

实验性 E2E 测试专业技能族 — 框架中立的 E2E 规格编制、审阅、修复与 proof reconcile（证明调和）。

仓库地址：[github.com/ifoohoo/e2e-test](https://github.com/ifoohoo/e2e-test)

## 状态

**实验性候选** — 五个服务具备已验证的运行骨架；操作资格、方法前向资格与发布制品认证分别取证，互不推出。

- `e2e-test-help`：只读诊断入口，始终可用。
- `e2e-test`、`e2e-test-author`、`e2e-test-review`、`e2e-test-repair`：未绑定时 fail-closed；author/repair 默认只生成预览，必须由用户明确确认后使用一次性 handle 提交。
- `operationalQualification`（操作资格）：双宿主运行协议资格，沿用独立证据。
- `methodForwardQualification`（方法前向资格）：三套未知需求包已准备，真实双宿主方法试验完成前保持 `FORWARD_TRIALS_PENDING_CODEX`，不得冒充通过。
- `releaseArtifactCertification`（发布制品认证）：尚未实施，显示为 `null`。
- finding 能力以 `assets/finding-capability-manifest.json` 为准；E2E-F-002、E2E-F-006、E2E-F-010 现为 implemented（通用语义 detector + 结构化 reviewer packet，不按 fixture 名称硬编码），不再阻断稳定成熟；前向 6+6+6 资格未做，不宣称 deterministic/stable。
- 默认 **NOT_ENABLED**（未启用）：需要项目显式 binding 才能启用。
- v0.2.0-alpha.4 是当前 GitHub prerelease（PUBLIC_RELEASE_READY）；alpha.1、alpha.2 和 alpha.3 是既有 prerelease。统一 marketplace 可用性由独立事务治理。Registry 0.2 正式公共发布和 E2E Test Gate B 正式公共发布（RELEASE_ATTESTED）仍是后续独立事务；alpha.4 不等于 RELEASE_ATTESTED。
- `artifact.e2e-test.browser.implement` 和 `artifact.e2e-test.browser.execute` 在显式 ExtensionBinding 下实验性可调用；默认 NOT_ENABLED。
- 不替代 `artifact-chain-assistant` 的通用 `e2e`。

<!-- release-skill:capability:external-write-boundary -->
> **当前发布边界：** v0.2.0-alpha.4 是当前 GitHub prerelease
>（PUBLIC_RELEASE_READY），统一 marketplace 可用性由独立事务治理；
> v0.2.0-alpha.1、alpha.2 和 alpha.3 是既有 prerelease。
> Gate B 操作资格为 `CANDIDATE_QUALIFIED`（候选合格），**非
> `RELEASE_ATTESTED`**（发布认证）；方法前向资格仍为
> `FORWARD_TRIALS_PENDING_CODEX`（真实双宿主试验尚未完成）；发布制品认证为
> `null`。本技能族默认 `NOT_ENABLED`（未启用），未绑定时 fail-closed。alpha.4
> 不等于 Gate B RELEASE_ATTESTED——请勿将本 prerelease 视为 Gate B 正式公共发布。implement/
> execute 在显式 ExtensionBinding 下实验性可调用；默认 NOT_ENABLED。

<!-- release-skill:capability:safe-first-command -->
> **从这里开始：** 安全的只读入口是 `e2e-test-help` 诊断技能，用于查看当前
> Gate B 状态与能力清单，不写文件、不触发外部操作。安装后请先运行
> `e2e-test-help` 了解当前状态。其余服务（`e2e-test-author`、
> `e2e-test-review`、`e2e-test-repair`）默认 `NOT_ENABLED`，需要项目显式
> binding 后才能使用。

## 安装

目前不支持通过 npm 安装，本插件仅通过统一插件市场分发。请使用下方 Claude Code 或 Codex 市场命令完成安装。

从统一市场 `ifoohoo/artifact-skill-set` 安装：

```bash
# Claude Code — 从市场安装
claude plugin marketplace add ifoohoo/artifact-skill-set
claude plugin install e2e-test@artifact-skill-set

# Codex — 从市场安装
codex plugin marketplace add ifoohoo/artifact-skill-set --ref main
codex plugin add e2e-test@artifact-skill-set
```

详细安装说明请参见 [INSTALL.md](INSTALL.md)。

## 快速开始

```bash
# 查看安装、合同、能力与三种资格状态
node scripts/gate-status.mjs --json
```

## 最小示例

安装后，运行只读诊断查看当前 Gate B 状态与能力清单。该操作不写文件、不触发外部动作。

```bash
# 运行 e2e-test-help 诊断（只读，安全的第一步）
e2e-test-help
```

`e2e-test-help` 是唯一始终可用的入口。其余服务（`e2e-test-author`、`e2e-test-review`、`e2e-test-repair`）默认 `NOT_ENABLED`，需要在项目中显式 binding 后才能启用——详见 [INSTALL.md](INSTALL.md) 的绑定说明。

## 故障诊断

常见故障形态与含义：

- **NOT_ENABLED（fail-closed）**：如果服务在未绑定时失败并返回 `NOT_ENABLED`，这是预期行为——`e2e-test-author`、`e2e-test-review`、`e2e-test-repair` 需要项目显式 binding。请按 INSTALL.md 完成绑定后重试。
- **Gate B 候选状态**：`e2e-test-help` 会如实报告当前资格状态。如果显示 `CANDIDATE_QUALIFIED`（非 `RELEASE_ATTESTED`）或方法前向资格为 `FORWARD_TRIALS_PENDING_CODEX`，这些是当前 Gate B 候选阶段的已知状态，不是错误。
- **如果服务执行失败**：先查看 `e2e-test-help` 诊断输出与 conformance / behavior-qualification 证据状态；门禁与 attestation 文件不得手工篡改。
- **GATE_FAILED / PARTIAL**：门禁结果码表示需要人工介入排查，不得自动覆盖或篡改证据制品。

## 架构

本技能族遵守 `artifact-chain-assistant` 定义的 E2E Test Skill Family API（技能族 API）：

- 符合 Artifact Contract（制品契约）`artifact.e2e-test@1`
- 实现 Family API（技能族 API）`artifact.e2e-test-family@1`
- 默认整族原子绑定（无 mixSafe 混绑）
- 生命周期：independent / experimental；目录 channel 与成熟度相互独立

## 许可证

Apache-2.0，详见 `LICENSE` 与 `NOTICE`。
