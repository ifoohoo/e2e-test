// review-kernel.mjs — 统一 review 内核
//
// M1-A（§5.2 req 5）：standalone review 与 author 内部 review-core 必须共用同一内核，
// 保证同一冻结输入产生同构 findings。原 standalone 路径自带的 runSemanticReviewRules
// 只扫 artifact 的 E2E-F-001/003/004/005/007，与内部 FINDING_HANDLERS 是两套内核；
// 现统一收敛到本模块。

import { FINDING_HANDLERS } from './finding-handlers.mjs';

/**
 * 运行统一语义评审内核。
 * @param {Object} ctx
 * @param {Object|null} ctx.artifact 制品
 * @param {Object|null} ctx.matrix  八维矩阵
 * @param {Object|null} ctx.packageManifest 包清单（artifact-package-manifest）
 * @param {Object|null} ctx.proofBinding proof 绑定（内部路径提供）
 * @param {Object|null} ctx.proofContext proof 上下文（内部路径提供）
 * @returns {Array} findings（统一形状，含 rule/severity/repairability 等）
 */
export function runReview(ctx = {}) {
  const context = {
    artifact: ctx.artifact ?? null,
    matrix: ctx.matrix ?? null,
    packageManifest: ctx.packageManifest ?? null,
    proofBinding: ctx.proofBinding ?? null,
    proofContext: ctx.proofContext ?? null,
  };
  const findings = [];
  for (const handler of Object.values(FINDING_HANDLERS)) {
    try {
      const result = handler.detect(context);
      if (Array.isArray(result)) findings.push(...result);
    } catch {
      // 单条规则检测异常不应中断其余规则；一致性问题由 validate 阶段捕获。
    }
  }
  // 与 author 内部路径（worker-runtime buildStageResult）同构：补齐 description，
  // 满足 review-result.json schema 的 required 字段。
  return findings.map(item => ({
    ...item,
    description: item.description || item.evidence || `${item.rule} detected`,
  }));
}
