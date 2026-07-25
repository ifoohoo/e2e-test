# 贡献指南

感谢你有兴趣参与 e2e-test 技能族。本项目是 experimental（实验性）的 E2E 规格技能族，当前处于 Gate B 候选阶段；参与前请先阅读 README.md 与 INSTALL.md 了解定位与安装方式。

## 问题反馈

- 功能问题、缺陷与文档改进请在 [ifoohoo/e2e-test](https://github.com/ifoohoo/e2e-test) 的 issues 中提交。
- 安全相关问题请遵循 SECURITY.md 的私下报告流程，不要在公开 issue 中披露利用细节。

## 开发环境

要求 Node.js 22 及以上、pnpm 10 及以上。

```bash
pnpm install
pnpm test          # 运行测试与真实性校验
pnpm build:check   # 确认 adapter 生成无漂移
```

## 技能编辑约定

- `skills/` 是技能内容的唯一 authoring source（创作源）。修改任何技能的 SKILL.md 后，必须运行 adapter 生成，使 Claude 与 Codex 两个适配器的副本保持同步：

  ```bash
  pnpm build          # 重新生成 adapters/claude 与 adapters/codex
  pnpm build:check    # 校验生成结果与源一致（无漂移）
  ```

- `scripts/` 下的确定性脚本是唯一脚本 authoring source；适配器目录中的同名脚本由生成流程同步，不要手工编辑。
- 修改技能或脚本后，提交前至少运行：`pnpm test`、`pnpm build:check`。

## 真实性与门禁

- 本项目的 SPI（服务提供者标识）`io.github.mzdbxqh.*` 与 attestation（认证记录）是 Registry 校验的真实性证据，贡献中不得改写、移动或重新签名。
- 不要手工修改 `conformance/last-run.json`、`conformance/behavior-qualification.json`、`family/implementation.yaml` 中的 SPI、treeDigest 与 attestation 字段；这些值只能由确定性流程产生。
- bundle treeDigest 变化意味着技能内容变更，需要走完整的重新认证流程，不能只改摘要值。

## 提交规范

- 一个 PR 聚焦一个目标，附带变更说明与验证结果。
- 提交信息使用祈使句，简明描述动机与影响。
- 涉及发布产物的变更必须同时通过公开边界与真实性校验。

## 许可证

本项目采用 Apache-2.0 许可证。提交贡献即表示你同意以 Apache-2.0 许可你的贡献内容。
