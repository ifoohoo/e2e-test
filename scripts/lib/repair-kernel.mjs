// repair-kernel.mjs — 统一 repair 内核
//
// M1-A（§5.2 req 3/5）：standalone repair 与 author 内部 repair-core 必须共用同一内核，
// 且修复必须以单一摘要约束事务同步更新三件套（artifact / matrix / package manifest）。
//
// 权威层语义：oracle/cleanup 的权威来源在 matrix（MATRIX_FIELD_MANIFEST 声明
// authoritative: 'matrix'）。因此修复顺序固定为：
//   1. REPAIR_HANDLERS 修 matrix 权威层（同时更新 artifact 投影提示）；
//   2. 对每个被修复的 case，用 projectCaseToArtifact 从 matrix 重投影 artifact case，
//      消除任何手写投影漂移，保证 round-trip（E2E-F-011）闭合；
//   3. 调用方以修复后的 artifact + matrix 重绑 package manifest（bindArtifactToMatrix），
//      旧 manifest 的 packageDigest 立即失效 → 旧摘要指向被拒绝。
//
// 兼容旧的 artifact-only 单元调用：未传 matrix 时退化为仅修 artifact 投影层。

import { REPAIR_HANDLERS } from './finding-handlers.mjs';
import { loadFindingManifest } from './finding-manifest.mjs';
import { projectCaseToArtifact } from './matrix-dto.mjs';

/**
 * 应用确定性安全修复处理器（三件套事务模式）。
 * @param {Object} artifact 待修复制品（结构化克隆，不修改原对象）
 * @param {Array} findings review 产出的 findings
 * @param {Object} plan 修复计划 { [rule]: planItem }
 * @param {string} [pluginRoot] 插件根目录（用于加载 manifest 校验 repairability）
 * @param {Object} [matrix] 八维矩阵（提供时进入权威层事务模式；克隆，不修改原对象）
 * @returns {{ artifact: Object, matrix: Object|null, repairs: Array, needsInput: Array, repairedCaseIds: string[] }}
 */
export function applyRepairs(artifact, findings, plan = {}, pluginRoot, matrix = null) {
  const repairedArtifact = structuredClone(artifact);
  const repairedMatrix = matrix ? structuredClone(matrix) : null;
  const { rules } = pluginRoot ? loadFindingManifest(pluginRoot) : { rules: new Map() };
  const repairs = [];
  const needsInput = [];
  const repairedCaseIds = new Set();
  for (const finding of findings) {
    const capability = rules?.get?.(finding.rule);
    const handler = REPAIR_HANDLERS[finding.rule];
    // 未提供 pluginRoot 时（如纯单元调用）默认信任 REPAIR_HANDLERS 为 safe-fix。
    const safeFix = capability ? capability.repairability === 'safe-fix' : Boolean(handler);
    if (!handler || !safeFix) {
      needsInput.push({ field: finding.rule, reason: '该 finding 需要业务决策、外部处理或尚无安全修复处理器' });
      continue;
    }
    const result = handler.apply(repairedArtifact, plan?.[finding.rule], finding, repairedMatrix);
    repairs.push({ rule: finding.rule, ...result });
    if (!result.fixed) needsInput.push({ field: finding.rule, reason: result.reason || '修复计划不足' });
    else if (result.case_ref) repairedCaseIds.add(result.case_ref);
  }
  // 修复计划键必须命中当前评审 findings；指向不存在 finding 的计划是无效输入，
  // 失败关闭为 NEEDS_INPUT（防止凭空修复或掩盖评审结果漂移）。
  const findingRules = new Set(findings.map(item => item.rule));
  for (const rule of Object.keys(plan || {})) {
    if (!findingRules.has(rule)) {
      needsInput.push({ field: rule, reason: '修复计划指向的 finding 不在当前评审结果中' });
    }
  }
  // 权威层事务：被修复的 case 一律从 matrix 重投影，杜绝 artifact 侧投影漂移。
  if (repairedMatrix) {
    for (const caseId of repairedCaseIds) {
      const matrixCase = repairedMatrix.cases?.find(item => item.case_id === caseId);
      const index = repairedArtifact.test_cases?.findIndex(item => item.case_id === caseId);
      if (matrixCase && index >= 0) {
        repairedArtifact.test_cases[index] = projectCaseToArtifact(repairedMatrix, matrixCase);
      }
    }
  }
  return { artifact: repairedArtifact, matrix: repairedMatrix, repairs, needsInput, repairedCaseIds: [...repairedCaseIds] };
}
