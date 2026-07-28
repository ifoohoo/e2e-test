---
name: e2e-test-help
description: 只读诊断入口，输出 Gate 状态、API/contract digest、能力清单、安装/启用/兼容/信任/解析状态和下一步。
---

# e2e-test-help

## 触发条件

用户使用 `e2e-test-help` 或请求查看 E2E 测试技能族状态/诊断。

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 在系统临时目录准备只含 `{"service":"help"}` 的 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/service-runner.mjs" --request <request.json> --json`。
3. help 是无 binding 只读入口，不经过 binding 验证。
4. 解析输出并格式化为可读诊断报告。
5. 说明适用/不适用场景、最小示例、profile overlay、诊断和下一步；明确 author/repair 为“预览→用户确认→一次性提交”。
6. 未绑定时说明如何由 `artifact-chain-help`/`where-am-i` 推荐并由项目显式采用。

## 权限

- 只读：不得创建、修改或删除任何项目文件。
- 可以读取 Registry 公共 API 的可用性诊断，但不创建 binding、不进行写操作。
- 不进入领域 workflow。

## 输出合同

- 成功码：`HELP_READY`
- 版本、Gate 状态、API/contract 精确 digest
- 安装/启用/兼容/信任/解析状态
- 能力清单、适用场景、最小示例
- finding 能力清单（`findingCapabilities`）：由 `assets/finding-capability-manifest.json` 推导的 manifest digest、implemented/planned 规则集与 `stableBlocked`；E2E-F-002/F-006/F-010 现为 implemented（通用语义 detector + 结构化 reviewer packet），不再阻断 stable，但前向 6+6+6 资格未做，不得宣称 deterministic/stable；与 gate-status 同源一致
- 诊断：确定性 conformance、`operationalQualification`（双宿主运行资格）、`methodForwardQualification`（未知需求前向方法资格）、`releaseArtifactCertification`（发布制品认证）和 adapter 状态
- 三种资格独立显示：方法资格为 `FORWARD_TRIALS_PENDING_CODEX` 时必须原样报告；发布认证未实施时必须显示 `null`，不得由运行资格推导
- where-am-i 引导，零项目写入
