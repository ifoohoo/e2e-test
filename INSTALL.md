# 安装 e2e-test

仓库地址：[github.com/ifoohoo/e2e-test](https://github.com/ifoohoo/e2e-test)

## 环境要求

- Node.js >= 22
- pnpm 或 npm
- 任一宿主：[Codex](https://codex.ai) 或 [Claude Code](https://claude.ai/code)
- 可选的同级依赖（完整功能需要）：
  - `agent-method-registry >=0.2.0`
  - `artifact-graph >=0.6.1`

## 安装方式

### 通过 npm 安装

```bash
npm install e2e-test
```

注意：Registry 0.2 和 E2E Test 尚未发布。

### 作为 Codex 插件安装

1. 将 `.codex-plugin/plugin.json` 复制到项目的 `.codex-plugin/` 目录。
2. 下次启动 Codex 会话时会自动发现该插件。

### 作为 Claude Code 市场插件安装

1. 将 `.claude-plugin/marketplace.json` 复制到项目的 `.claude-plugin/` 目录。
2. 重启 Claude Code 以完成插件发现。

## 验证安装

```bash
# 查看 Gate B 三种资格状态
node node_modules/e2e-test/scripts/gate-status.mjs --json
```

## 当前 Gate B 行为

安装之后（未做项目绑定时）：

- `e2e-test-help` 作为只读诊断技能可用，展示 Gate B 状态。
- `e2e-test`、`e2e-test-author`、`e2e-test-review`、`e2e-test-repair` 四个服务入口已实现，但未绑定时 **fail-closed**。
- 插件**默认不启用**（NOT_ENABLED），不替代 `artifact-chain-assistant` 的通用 `e2e`。
- 启用提供方服务需要项目显式 binding。
- author 与 repair 首先返回零写入预览；如需写入项目文件，必须使用同一个一次性 handle 与 binding 再次发起明确提交请求。
- `gate-status` 独立报告操作资格、方法前向资格与发布制品认证；pending 或 `null` 均为有意状态，不得视为通过。
- 缺少可选同级依赖时：help 如实报告；其他服务 fail-closed 并输出稳定诊断。

## 后续步骤

- 运行 `e2e-test-help` 查看完整能力清单与 Gate B 状态。
- 发布历史见 `CHANGELOG.md`。
- 在项目的 `agent-method-registry` 配置中绑定提供方，即可启用完整功能。

## 许可证

Apache-2.0，详见 `LICENSE` 与 `NOTICE`。
