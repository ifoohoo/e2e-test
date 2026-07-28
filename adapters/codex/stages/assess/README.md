# assess stage

运行候选判定规则，筛选进入 E2E 的路径，记录下沉项。

## 输入

- `inspection.json` from inspect stage

## 输出

- `candidate-assessment.json` — 候选判定结果，含 E2E 和下沉项（schema: `schemas/candidate-assessment.json`）
- stage result envelope（schema: `schemas/stage-result.json`）

## 确定性规则

- 每个候选必须至少满足 C1（跨边界）、C2（核心价值旅程）、C3（真实协同风险）或 C4（证明性需求）之一。
- 不满足条件的路径记录为下沉项（DOWNSTREAM），不得包装为 E2E。
- 纯算法、单类、单接口参数组合必须下沉。
- 下沉项必须指定 target（unit/integration/contract）和 reason。
