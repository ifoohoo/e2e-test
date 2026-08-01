---
name: e2e-test-stage-inspect
description: 仅供 E2E author 内部编排读取原始 PRD、场景和项目事实，产出 inspection DTO；不是用户入口。
---

# Inspect 内部工序

只在 author 编排要求 `stage: inspect` 时使用。读取已由运行时快照并钉住的来源，不自行搜索未授权路径。

工作目标：提取业务目标、参与者、关键旅程、跨系统边界、依赖、不确定项和候选路径。不要在此阶段决定用例组合。

输出必须是 `../../schemas/inspection.json`；`inputs.source_ids` 覆盖全部来源引用。目标、参与者或关键旅程无法可靠提取时，返回结构化 `needs_input[{field,reason}]`，不得填入 “N/A”。

交付给 `../../workers/inspect-worker.mjs` 校验，不直接写项目文件。
