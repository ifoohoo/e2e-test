# E2E 内部工序 Worker 合同

八个 worker 是 `artifact.e2e-test-family@1` 的内部执行单元，不是用户入口，也不进入 Registry 服务投影。

每个文件只导出稳定 `workerId` 与异步 `run(input)`。输入必须包含 `stage`、`runId`、`runRoot`、`pluginRoot`、`inputs` 和 `writeSet`；模型工序通过 `stageOutput` 交付业务判断，确定性 worker 不得用关键词替代未知业务设计。

共同不变量：

- 只写 `runRoot/stage-results` 与 `runRoot/intermediates`，不写目标项目。
- 第二至第八工序必须复验前序完整信封及摘要。
- 时间戳由调用方注入，缺省使用固定纪元时间，禁止读取墙钟。
- 输出先通过 `schemas/stage-result.json`，再用临时文件加原子重命名落盘。
- `NEEDS_INPUT` 保持在当前工序；失败或阻断不得推进后继工序。
- worker 不调用其他 worker；跨工序只通过结构化 Stage Result 交接。

专业方法见各 `stages/<stage>/SKILL.md`，确定性校验见 `scripts/stage-validators/`。
