# 方法前向试验 Rubric

该评分用于未知原始需求包上的独立方法审阅，不读取任何期望中间工件或标准答案。结构权威是 `schemas/forward-trial-rubric.json`。

八个维度分别评价：候选取舍、业务边界、Oracle 质量、隔离与清理、异常与恢复、追溯、八维矩阵保真、可执行性。每一项都必须引用宿主实际输出的工件或 case；八项全部为 `pass` 才能得到总体 `PASS`，任一 `fail` 即总体 `FAIL`，其余为 `PARTIAL`。

前向资格与操作资格相互独立：脚本可运行并不证明方法能从未知需求设计出高质量规格；一次好的方法输出也不替代安装、Registry、写集和宿主安全门。

## 控制平面

方法正向试验使用三个彼此分离的控制面：

1. `method-forward-trial-runner.mjs prepare|run|verify`：冻结未知输入、插件主体和宿主身份；启动单次隔离作者试验；退出后从事件、八个阶段结果、三件套预览和目录写集重建结论。
2. `method-forward-reviewer.mjs prepare|run|verify`：为单次试验生成只含本包原始输入和本宿主实际输出的只读盲评包；使用独立进程评分；根据访问收据、身份绑定、证据引用和总体分数重新验证 rubric。
3. `method-forward-qualification-aggregate.mjs`：只接受精确的两个宿主乘三个业务包，以及六份已验证 rubric；重复、缺失、额外、摘要漂移或盲性证据缺失一律失败关闭。

`prepare`、`run`、`verify` 必须分开执行。宿主和 reviewer 只能写各自独立的工作根；原始包、插件主体和 reviewer packet 在执行前后摘要必须一致。公开结果只含相对证据引用和内容摘要，原始控制事件可留在本地 evidence 根，但不得进入公开资格文件。

## 资格防火墙

- `evidenceMode=synthetic` 只用于伪宿主和安装态基础设施回归。六次合成试验即使全部通过，也只能得到 `FORWARD_INFRA_ACCEPTANCE_CANDIDATE`，不能生成或覆盖正式 `QUALIFIED`。
- `readExpectedAnswers: false` 只是声明，不构成盲性证明。盲性由 reviewer packet 白名单、独立只读根、控制平面访问收据和事件流共同证明。
- 确定性校验器只验证结构、身份、摘要、文件包含关系和评分归约；八维语义结论必须来自独立大模型或人工 reviewer。
- 真实两个宿主各完成三个未知业务包，且六份语义 rubric 均为 `PASS` 前，正式状态必须保持 `FORWARD_TRIALS_PENDING_CODEX`。

## 失败关闭

以下任一情况不得进入资格聚合：宿主不可用或超时、事件流非结构化、未读取 author 入口、额外工具、输入或插件漂移、越界写入、八工序缺失或摘要错误、预览缺失、绝对路径泄漏、packet 混入其他试验、rubric 身份或摘要不一致、证据引用越界、总体分数与八维明细不一致。
