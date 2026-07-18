# E2E Test Plugin Agent Guide

## 定位

本目录是 `e2e-test` 技能族的公开插件包，是唯一公开发布源。

## 语言规则

- 面向用户的文档和交互默认使用中文。
- 命令、路径、包名、API 名、JSON/YAML 字段和代码标识符保留英文。

## 技能说明

当前 Gate A 状态：

| 技能 | 状态 | 说明 |
|------|------|------|
| `e2e-test-help` | 可用 | 只读诊断入口，输出 Gate A 状态、能力清单和下一步 |
| `e2e-test` | fail-closed | 默认入口，返回 `GATE_B_REQUIRED` |
| `e2e-test-author` | fail-closed | 返回 `NOT_IMPLEMENTED` |
| `e2e-test-review` | fail-closed | 返回 `NOT_IMPLEMENTED` |
| `e2e-test-repair` | fail-closed | 返回 `NOT_IMPLEMENTED` |

## 边界

- 不得声明 author/review/repair 已实现或可用于真实项目。
- 不得生成 agent-method provider catalog 或进入 effective index。
- 不得默认 enabled。
- 不得替换或遮蔽 `artifact-chain-assistant` 的通用 `e2e`。
- 不得把草案 contract/API 冒充官方权威。
- 不得复制 `loop-agent`、`flow-architect` 或 `glaf4-test` 的领域协议。
