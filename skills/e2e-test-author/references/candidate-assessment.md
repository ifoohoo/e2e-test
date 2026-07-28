# E2E 候选判定规则

## 进入 E2E 的必要条件

一个测试路径进入 E2E 覆盖必须至少满足以下一项：

### C1: 跨边界

路径跨越两个以上部署/进程/信任/外部边界。例如：
- 前端 → API → 数据库 → 外部支付网关
- 用户空间 → 权限边界 → 管理后台
- 客户端 → CDN → 源站 → 缓存层

### C2: 核心价值旅程

路径是核心业务价值旅程且失败损失高。例如：
- 用户注册 → 支付 → 订单完成
- 数据导入 → 转换 → 导出的完整链路

### C3: 真实协同风险

风险只在真实系统协同中出现，下层测试无法捕获。例如：
- 分布式事务一致性
- 跨服务消息传递顺序
- 竞态条件在集成边界

### C4: 证明性需求

需要证明补偿、恢复、幂等、权限或一致性。例如：
- 支付失败后订单状态回滚
- 重复提交的幂等处理
- 越权访问拒绝

## 不得进入 E2E 的路径

以下路径必须记录为下沉项，不得包装为 E2E：

| 类型 | 原因 | 下沉目标 |
|------|------|---------|
| 纯算法 | 可由单元测试充分证明 | unit |
| 单类/单接口参数组合 | 可由契约测试覆盖 | contract / integration |
| 可由契约测试稳定证明的规则 | 不需要真实系统协同 | contract |
| 追求覆盖率的重复路径 | 不增加风险覆盖 | 删除或合并 |

## E2E 候选必须给出结构化充分理由

每个 `decision: "E2E"` 的候选必须携带 `e2e_rationale`，否则 assess 阶段失败关闭。理由不得只列 `C3/C4` 标签或重复 `path_summary`，必须同时说明：

- `criteria_meanings`：`criteria_met` 中**每个**准则（C1-C4）都要有一条含义说明，解释该准则在本路径上的具体含义，不得只是准则标签本身。
- `collaboration_risk`：真实协同风险或业务损失——只在真实系统协同中出现、下层测试无法捕获的风险，或失败造成的业务损失。
- `lower_tier_insufficiency`：为什么 unit/integration/contract 不能充分证明该路径，不得重复 `path_summary` 或 `collaboration_risk`。

机械校验（`scripts/lib/candidate-assessment.mjs`）会失败关闭：缺理由、标签式理由、重复 `path_summary`、`criteria_met` 中某准则缺含义、`lower_tier_insufficiency` 与 `collaboration_risk` 雷同。下沉项（`DOWNSTREAM`）不受此约束，仍须保留。

## 候选评估输出

```json
{
  "candidate_id": "CAND-001",
  "feature_id": "F-001",
  "ac_id": "AC-001",
  "criteria_met": ["C1", "C2"],
  "path_summary": "跨前端、API 和支付网关的完整支付流程",
  "risk_level": "high",
  "decision": "E2E",
  "e2e_rationale": {
    "criteria_meanings": [
      { "criterion": "C1", "meaning": "路径跨越前端、API 与支付网关三个独立部署边界，任一边界契约漂移都会改变端到端结果" },
      { "criterion": "C2", "meaning": "下单到支付完成是核心营收旅程，失败直接造成订单流失与资金不一致" }
    ],
    "collaboration_risk": "支付授权与订单落库分布在不同服务，真实协同下才暴露超时与部分成功，单服务测试无法复现这些时序耦合",
    "lower_tier_insufficiency": "单元测试只覆盖单服务分支，契约测试只校验两两接口字段，都无法证明跨三个边界的资金最终一致，必须由 E2E 真实协同证明"
  },
  "downstream": null
}
```

对于下沉项：

```json
{
  "candidate_id": "CAND-002",
  "feature_id": "F-002",
  "ac_id": "AC-003",
  "criteria_met": [],
  "path_summary": "单一接口参数验证",
  "risk_level": "low",
  "decision": "DOWNSTREAM",
  "downstream": {
    "target": "contract",
    "reason": "单接口参数组合可由契约测试覆盖"
  }
}
```
