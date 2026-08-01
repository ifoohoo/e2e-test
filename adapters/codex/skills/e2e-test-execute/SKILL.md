---
name: e2e-test-execute
description: E2E 浏览器 execute 技能。通过 browser-extension-runner.mjs 运行真实 Playwright 测试并生成规范执行结果。
---

# e2e-test-execute

## 触发条件

用户请求运行已实现的 Playwright 浏览器测试、执行浏览器自动化测试、或明确使用 `e2e-test-execute`。

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 根据用户授权准备 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/browser-extension-runner.mjs" --request <request.json> --json`。
   runner 在同一次调用中完成输入验证与 M5 内核组合。
3. request 最小字段：
   - `action`: `"execute.preview"`（预览）或 `"execute.run"`（执行）
   - `projectRoot`: 隔离项目绝对路径
   - `binding`: 完整 `ExtensionBinding`，包含 `extensionId`、`service`、`enabled`、`status` 等
   - `inputs`: M5 内核所需输入（commitResult、baseURL、allowlist 等）
4. `execute.preview` 返回零写入预览，展示执行计划。
5. 向用户展示预览并取得明确执行授权后，才以 `execute.run` 再次调用。
6. 缺少 projectRoot、ExtensionBinding、inputs 等关键输入时，返回 `BLOCKED`。

## Session 模式

当需要跨动作信任链（如 implement.commit → execute.preview → execute.run）时，使用 session 模式：

```bash
node "$PLUGIN_ROOT/scripts/browser-extension-runner.mjs" --session --json << 'EOF'
{"action":"implement.preview","projectRoot":"...","binding":{...},"inputs":{...}}
{"action":"implement.commit","projectRoot":"...","binding":{...},"inputs":{"previewDigest":"..."}}
{"action":"execute.preview","projectRoot":"...","binding":{...},"inputs":{"baseURL":"http://localhost:3000"}}
{"action":"execute.run","projectRoot":"...","binding":{...},"inputs":{"planDigest":"..."}}
EOF
```

Session 模式在同一进程中维护 WeakMap 受信对象，确保：
- execute.preview 只能消费同一 session 中 implement.commit 返回的真实 commitResult
- session 外注入的 commitResult 会被拒绝（返回 `M5_PLAN_COMMIT_UNTRUSTED`）
- execute.run 需要回传精确 planDigest 作为执行授权确认

## 当前边界

- **execute.preview**：需要同一 session 中的真实 commitResult，调用 M5 prepareExecutionPlan
- **execute.run**：需要同一 session 中的 planDigest，使用真实 Chromium 执行宿主运行 Playwright 测试并返回 canonical result

## 权限

- 默认预览：execute 先输出预览，用户确认后才执行。
- 只有用户明确授权且 binding 有效时才能执行测试。
- 执行前验证 ExtensionBinding、service 匹配和 binding 状态。
- 不复制 M4/M5 内核的业务实现。
- 不允许直接调用 M4/M5 内部模块绕过 runner。

## 输出合同

- 预览完成：`EXECUTE_PREVIEW_READY` + 执行计划预览；项目零写入。
- 执行成功：`EXECUTION_SUCCEEDED` + canonical result。
- `BLOCKED`：输入验证失败或权限不足。
