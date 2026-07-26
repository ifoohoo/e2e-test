import { validateMatrixRoundTrip } from './matrix-dto.mjs';
import { validateProofBinding } from './proof-state.mjs';

const INTERNAL_ORACLE_PATTERNS = [/querySelector/i, /XPath/i, /CSS/i, /SELECT\s/i, /数据库.*(?:表|行)/i, /函数调用/i, /#id/i];

function finding(rule, caseRef, evidence, overrides = {}) {
  return {
    rule,
    case_ref: caseRef,
    severity: overrides.severity || 'high',
    repairability: overrides.repairability || 'safe-fix',
    evidence,
  };
}

function artifactCases(ctx) {
  return ctx.artifact?.test_cases || [];
}

export const FINDING_HANDLERS = Object.freeze({
  'E2E-F-001': {
    kind: 'deterministic',
    detect(ctx) {
      return artifactCases(ctx).filter(item => !item.trace_targets?.length).map(item => finding('E2E-F-001', item.case_id, 'trace_targets empty'));
    },
  },
  'E2E-F-003': {
    kind: 'deterministic',
    detect(ctx) {
      const byId = new Map((ctx.matrix?.cases || []).map(item => [item.case_id, item]));
      return artifactCases(ctx).filter(item => {
        const matrixCase = byId.get(item.case_id);
        return !item.goal || !matrixCase?.actor_goal?.actor || !matrixCase?.value_risk?.business_value || !matrixCase?.path?.cross_boundary?.length;
      }).map(item => finding('E2E-F-003', item.case_id, 'actor/goal/value/boundary incomplete'));
    },
  },
  'E2E-F-004': {
    kind: 'deterministic',
    detect(ctx) {
      const cases = ctx.matrix?.cases || [];
      const hasHappy = cases.some(item => item.path?.path_class === 'happy');
      const hasRiskPath = cases.some(item => ['error', 'recovery', 'security'].includes(item.path?.path_class));
      const waived = cases.some(item => item.value_risk?.waiver);
      if (hasHappy && (hasRiskPath || waived)) return [];
      return [finding('E2E-F-004', '*', 'happy or error/recovery/security coverage absent without waiver', { repairability: 'business-decision' })];
    },
  },
  'E2E-F-005': {
    kind: 'deterministic',
    detect(ctx) {
      return artifactCases(ctx).flatMap(item => {
        const invalid = !item.oracles?.length || item.oracles.some(oracle => !oracle.timeout_ms || INTERNAL_ORACLE_PATTERNS.some(pattern => pattern.test(oracle.observable || '')));
        return invalid ? [finding('E2E-F-005', item.case_id, 'oracle missing, internal-detail based, or without timeout')] : [];
      });
    },
  },
  'E2E-F-007': {
    kind: 'deterministic',
    detect(ctx) {
      const byId = new Map((ctx.matrix?.cases || []).map(item => [item.case_id, item]));
      return artifactCases(ctx).filter(item => {
        const cleanup = byId.get(item.case_id)?.cleanup;
        return !cleanup?.cleanup_steps?.length || !cleanup?.failure_cleanup?.length || !cleanup?.compensation?.length;
      }).map(item => finding('E2E-F-007', item.case_id, 'normal/failure/compensation cleanup incomplete', { severity: 'medium' }));
    },
  },
  'E2E-F-008': {
    kind: 'deterministic',
    detect(ctx) {
      return validateProofBinding(ctx.proofBinding || { bindings: [] }, ctx.proofContext || {}).findings.filter(item => item.rule === 'E2E-F-008');
    },
  },
  'E2E-F-009': {
    kind: 'deterministic',
    detect(ctx) {
      return validateProofBinding(ctx.proofBinding || { bindings: [] }, ctx.proofContext || {}).findings.filter(item => item.rule === 'E2E-F-009');
    },
  },
  'E2E-F-011': {
    kind: 'deterministic',
    detect(ctx) {
      if (!ctx.matrix || !ctx.artifact) return [];
      const result = validateMatrixRoundTrip(ctx.matrix, ctx.artifact, ctx.companion || ctx.matrix);
      return result.complete ? [] : [finding('E2E-F-011', '*', JSON.stringify(result.missing), { severity: 'medium' })];
    },
  },
  'E2E-F-012': {
    kind: 'deterministic',
    detect(ctx) {
      return validateProofBinding(ctx.proofBinding || { bindings: [] }, ctx.proofContext || {}).findings.filter(item => item.rule === 'E2E-F-012');
    },
  },
});

export const REPAIR_HANDLERS = Object.freeze({
  'E2E-F-005': {
    apply(artifact, plan, findingItem) {
      const caseItem = artifact.test_cases?.find(item => item.case_id === findingItem.case_ref);
      if (!caseItem || !plan?.replacementOracle) return { fixed: false, reason: 'replacementOracle required' };
      caseItem.oracles = [structuredClone(plan.replacementOracle)];
      return { fixed: true, case_ref: findingItem.case_ref };
    },
  },
  'E2E-F-007': {
    apply(artifact, plan, findingItem) {
      const caseItem = artifact.test_cases?.find(item => item.case_id === findingItem.case_ref);
      if (!caseItem || !plan?.additionalCleanup?.length) return { fixed: false, reason: 'additionalCleanup required' };
      caseItem.cleanup = [...new Set([...(caseItem.cleanup || []), ...plan.additionalCleanup])];
      return { fixed: true, case_ref: findingItem.case_ref };
    },
  },
});
