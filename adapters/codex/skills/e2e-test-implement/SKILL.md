---
name: e2e-test-implement
description: E2E 浏览器 implement 技能。通过 browser-extension-runner.mjs 从已批准规格生成 Playwright 测试代码。
---

# e2e-test-implement

## 触发条件

用户请求从已批准 E2E 规格生成 Playwright 测试代码、实现浏览器自动化测试、或明确使用 `e2e-test-implement`。

## 执行顺序

1. 从 `SKILL.md` 路径向上两级解析 `PLUGIN_ROOT`。
2. 根据用户授权准备 request JSON，运行
   `node "$PLUGIN_ROOT/scripts/browser-extension-runner.mjs" --request <request.json> --json`。
   runner 在同一次调用中完成输入验证与 M4 内核组合。
3. request 最小字段：
   - `action`: `"implement.preview"`（预览）或 `"implement.commit"`（提交）
   - `projectRoot`: 隔离项目绝对路径
   - `binding`: 完整 `ExtensionBinding`，包含 `extensionId`、`service`、`enabled`、`status` 等
   - `inputs`: M4 内核所需输入（refs、profile、now 等）
4. `implement.preview` 返回零写入预览，展示计划、批准和输入摘要。
5. 向用户展示预览并取得明确提交授权后，才以 `implement.commit` 再次调用。
6. 缺少 projectRoot、ExtensionBinding、inputs 等关键输入时，返回 `BLOCKED`。

## Session 模式

当需要跨动作信任链（如 implement.preview → implement.commit → execute.preview）时，使用 session 模式：

```bash
node "$PLUGIN_ROOT/scripts/browser-extension-runner.mjs" --session --json << 'EOF'
{"action":"implement.preview","projectRoot":"...","binding":{...},"inputs":{...}}
{"action":"implement.commit","projectRoot":"...","binding":{...},"inputs":{"previewDigest":"..."}}
{"action":"execute.preview","projectRoot":"...","binding":{...},"inputs":{"baseURL":"http://localhost:3000"}}
{"action":"execute.run","projectRoot":"...","binding":{...},"inputs":{"planDigest":"..."}}
EOF
```

Session 模式在同一进程中维护 WeakMap 受信对象，确保：
- implement.commit 只能使用同一 session 中 implement.preview 返回的 previewDigest
- execute.preview 只能消费同一 session 中 implement.commit 返回的真实 commitResult
- execute.run 需要回传精确 planDigest 作为执行授权确认
- session 外注入的 commitResult 会被拒绝（返回 `M5_PLAN_COMMIT_UNTRUSTED`）

## 当前边界

- **implement.preview**：完整 M4 链组合（planner → draft → review → commit preview），返回完整 commit preview
- **implement.commit**：需要同一 session 中的 previewDigest，使用 M4 commit controller 签发 handle 并执行 commit
- **execute.preview**：需要同一 session 中的真实 commitResult，调用 M5 prepareExecutionPlan
- **execute.run**：需要同一 session 中的 planDigest，使用真实 Chromium 执行宿主运行 Playwright 测试并返回 canonical result

## 权限

- 默认预览：implement 先输出预览，用户确认后才落盘。
- 只有用户明确授权且 binding 有效时才能提交。
- 写前验证 ExtensionBinding、service 匹配和 binding 状态。
- 不复制 M4/M5 内核的业务实现。
- 不允许直接调用 M4/M5 内部模块绕过 runner。

## 输出合同

- 预览完成：`IMPLEMENT_PREVIEW_READY` + 计划预览；项目零写入。
- 提交成功：`IMPLEMENT_COMMIT_READY_TO_RUN` + 绑定清单。
- `BLOCKED`：输入验证失败或权限不足。
