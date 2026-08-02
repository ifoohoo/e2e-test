# e2e-test

实验性 E2E 测试专业技能族 — 框架中立的 E2E 规格编制、审阅、修复与 proof reconcile（证明调和）。

仓库地址：[github.com/ifoohoo/e2e-test](https://github.com/ifoohoo/e2e-test)

## 状态

**正式版** — 规格内核（help/default/author/review/repair）为 stable，具备 CANDIDATE_QUALIFIED 资格。浏览器扩展（implement/execute）仍为 experimental。操作资格、方法前向资格与发布制品认证分别取证，互不推出。

- `e2e-test-help`：只读诊断入口，始终可用。
- `e2e-test`、`e2e-test-author`、`e2e-test-review`、`e2e-test-repair`：stable；未绑定时 fail-closed；author/repair 默认只生成预览，必须由用户明确确认后使用一次性 handle 提交。
- `e2e-test-implement`、`e2e-test-execute`：**实验性**浏览器扩展技能，未绑定时 fail-closed；需要显式 ExtensionBinding；默认 NOT_ENABLED。
- `operationalQualification`（操作资格）：双宿主运行协议资格，沿用独立证据。
- `methodForwardQualification`（方法前向资格）：真实双宿主方法试验完成前保持 `FORWARD_TRIALS_PENDING_CODEX`，不得冒充通过。
- `releaseArtifactCertification`（发布制品认证）：尚未实施，显示为 `null`。
- finding 能力以 `assets/finding-capability-manifest.json` 为准；E2E-F-002、E2E-F-006 和 E2E-F-010 为 implemented（通用语义 detector + 结构化 reviewer packet，不按 fixture 名称硬编码）。
- 默认 **NOT_ENABLED**（未启用）：需要项目显式 binding 才能启用。
- v0.2.1 是当前正式版。该版本以自包含 Ajv/TypeScript 运行时 bundle 补齐 Git marketplace 安装闭包，全新 Claude/Codex 安装不再依赖仓库本地 `node_modules`。Claude/Codex 统一 marketplace 已在前一正式版完成验证；v0.2.1 的发布后安装复验属于本次发布事务。Gate B 的 Registry 前置已冻结为 `agent-method-registry@0.2.2`（GitHub tag `agent-method-registry-v0.2.2`，commit `2d15ae574e122c5dfabf245680b5a8de628d27e4`，npm integrity `sha512-uQbsnVLBkm2yeEIHdtHu8NUjgDgheYvNF8wZfvHpCSk7pnmGWW93P31fPmer9IowWmh2f55I5FguxX4czbxrvg==`）。E2E Test Gate B 正式公共发布（RELEASE_ATTESTED）仍是后续独立事务。
- `artifact.e2e-test.browser.implement` 和 `artifact.e2e-test.browser.execute` 在显式 ExtensionBinding 下实验性可调用；默认 NOT_ENABLED。
- 不替代 `artifact-chain-assistant` 的通用 `e2e`。

<!-- release-skill:capability:external-write-boundary -->
> **当前发布边界：** v0.2.1 是当前正式版。规格内核
>（help/default/author/review/repair）为 stable，具备 CANDIDATE_QUALIFIED
> 资格；Gate B RELEASE_ATTESTED 仍是后续独立事务。浏览器扩展
>（implement/execute）为 experimental，默认 NOT_ENABLED。方法前向资格仍为
> FORWARD_TRIALS_PENDING_CODEX；发布制品认证为 `null`。本技能族默认
> `NOT_ENABLED`（未启用），未绑定时 fail-closed。

<!-- release-skill:capability:safe-first-command -->
> **从这里开始：** 安全的只读入口是 `e2e-test-help` 诊断技能，用于查看当前
> Gate B 状态与能力清单，不写文件、不触发外部操作。安装后请先运行
> `e2e-test-help` 了解当前状态。其余服务（`e2e-test-author`、
> `e2e-test-review`、`e2e-test-repair`）默认 `NOT_ENABLED`，需要项目显式
> binding 后才能使用。

## 能做什么

| 技能 | 输入 | 产出 |
|------|------|------|
| **e2e-test-author** | 业务需求 / PRD / scenario | E2E 规格三件套（artifact.e2e-test@1 制品 + 八维矩阵 + 制品包 manifest） |
| **e2e-test-review** | 已有 E2E 规格制品 | 结构化审阅报告（findings、severity、repairability），覆盖 12 条规则 |
| **e2e-test-repair** | 审阅报告中的 open finding | 修复后规格预览 + 重审结果 |
| **e2e-test-implement**（实验性） | 已批准 E2E 规格 | Playwright 测试代码 |
| **e2e-test-execute**（实验性） | 已实现 Playwright 测试 | 真实 Chromium 执行的 canonical result，以及 reporter/退出状态、截图或 trace 引用、网络审计、资源事实、浏览器身份与清理状态等结构化证据 |

### 规格内核与浏览器扩展

**规格内核**（author / review / repair）完全在 E2E 规格制品上操作——不生成测试代码。它产出框架中立的规格，包含验证点、矩阵覆盖和 proof 声明。

**浏览器扩展**（implement / execute）将规格桥接到可运行的 Playwright 测试。在显式 `ExtensionBinding` 下：
- `implement` 从已批准规格生成 Playwright 测试代码
- `execute` 在真实 Chromium 浏览器中运行测试，返回 canonical result 与结构化证据

浏览器执行在运行前复验冻结的 browser channel/version；Docker 隔离宿主以操作系统级网络边界阻断非允许外连，并以 cgroup/进程树约束时长、内存和子进程。任何策略、资源、证据或清理条件不满足时都失败关闭，不把未执行或不完整执行记作通过。

implement 和 execute 均为**实验性**功能，默认 `NOT_ENABLED`——需要显式 ExtensionBinding 配置。

### 业务示例

以下示例描述从需求到浏览器执行证据的完整流程。所有调用均通过宿主（Claude Code 或 Codex）的 skill 机制触发——不提供独立 CLI 命令。

> **场景：电商下单流程**

```
用户（在 Claude Code 中）：
  "帮我为电商下单流程编制 E2E 测试规格"

→ e2e-test-author 生成规格预览（零写入）：
  - artifact.e2e-test@1 制品：包含验收标准、验证点、proof 声明
  - 八维矩阵：覆盖 happy path、边界、中断恢复等维度
  - 用户确认后提交，三件套落盘到指定 writeSet

用户：
  "审阅刚才生成的规格"

→ e2e-test-review 输出结构化审阅报告：
  - E2E-F-004（只有 happy path）：severity=warning, repairable
  - E2E-F-009（证据缺失）：severity=error, repairable

用户：
  "修复这些 finding"

→ e2e-test-repair 生成修复预览（零写入）：
  - 补充边界场景、补全 proof 声明
  - 用户确认后提交修复制品

用户（需要 ExtensionBinding 已配置）：
  "从批准的规格生成 Playwright 代码并在浏览器中执行"

→ e2e-test-implement 生成 Playwright 测试代码（预览→确认→提交）
→ e2e-test-execute 在真实 Chromium 中运行测试，返回：
  - canonical result（通过/失败/超时）
  - Playwright reporter、退出状态、截图或 trace 引用
  - 网络审计、资源事实、浏览器版本和清理状态
```

> **注意**：implement/execute 为实验性功能，需要显式 ExtensionBinding，默认 NOT_ENABLED。其余三个服务（author/review/repair）同样需要项目显式 binding 才能启用。

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
- **Gate B 候选状态**：`e2e-test-help` 会如实报告当前资格状态。如果显示 `CANDIDATE_QUALIFIED`（非 `RELEASE_ATTESTED`）或方法前向资格为 `FORWARD_TRIALS_PENDING_CODEX`，这些是当前阶段的已知状态，不是错误。
- **如果服务执行失败**：先查看 `e2e-test-help` 诊断输出与 conformance / behavior-qualification 证据状态；门禁与 attestation 文件不得手工篡改。
- **GATE_FAILED / PARTIAL**：门禁结果码表示需要人工介入排查，不得自动覆盖或篡改证据制品。

## 架构

本技能族遵守 `artifact-chain-assistant` 定义的 E2E Test Skill Family API（技能族 API）：

- 符合 Artifact Contract（制品契约）`artifact.e2e-test@1`
- 实现 Family API（技能族 API）`artifact.e2e-test-family@1`
- 默认整族原子绑定（无 mixSafe 混绑）
- 生命周期：independent / stable（核心）；experimental（浏览器扩展）

## 许可证

Apache-2.0，详见 `LICENSE` 与 `NOTICE`。
