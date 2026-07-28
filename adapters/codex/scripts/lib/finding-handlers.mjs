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
    ...(overrides.reviewerPacket ? { reviewer_packet: overrides.reviewerPacket } : {}),
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
  'E2E-F-002': {
    kind: 'semantic-review',
    detect(ctx) {
      const cases = ctx.matrix?.cases || [];
      const findings = [];
      for (const item of cases) {
        const actor = item.actor_goal?.actor || '';
        const goal = item.actor_goal?.goal || '';
        const risk = item.value_risk || {};
        const cross = item.path?.cross_boundary || [];
        const sources = item.source_scope || {};
        const signals = [];
        if (cross.length === 0) signals.push('C1-no-cross-boundary');
        if (/^(?:unit|integration|contract|module|function|class|component|service|internal|system|api|sdk|library|lib|db|database|util|helper|脚本|单元测试|集成测试|契约测试|模块|函数|类|组件|服务|内部|系统|库|工具)\b/i.test(actor.trim())) {
          signals.push('non-end-user-actor');
        }
        if (risk.risk_level === 'low' && cross.length === 0 && /(?:验证|校验|检查|计算|返回|抛出|格式化|解析|序列化|调用|确认|assert|verify|validate|check|compute|return|throw|format|parse|serialize|call)\b/i.test(goal)) {
          signals.push('technical-internal-goal');
        }
        if (item.path?.path_class === 'performance' && cross.length === 0) signals.push('perf-micro-benchmark');
        if (signals.length >= 2) {
          findings.push(finding('E2E-F-002', item.case_id, `non-E2E candidate signals: ${[...new Set(signals)].join(', ')}`, {
            severity: 'high',
            repairability: 'business-decision',
            reviewerPacket: {
              rule: 'E2E-F-002',
              evaluated_conditions: {
                C1_cross_boundary: cross.length > 0,
                C2_core_value_journey: Boolean(risk.business_value && risk.business_value.length > 0),
                C3_collaboration_risk: risk.risk_level && risk.risk_level !== 'low',
                C4_provenance: Boolean(sources.feature_ref || sources.source_artifact || sources.scenario_ref),
              },
              signals: [...new Set(signals)],
              recommendation: 'sink-to-unit-integration-contract',
              needs_human_review: true,
            },
          }));
        }
      }
      return findings;
    },
  },
  'E2E-F-006': {
    kind: 'semantic-review',
    detect(ctx) {
      const cases = ctx.matrix?.cases || [];
      const findings = [];
      for (const item of cases) {
        const di = item.data_identity;
        // 维度整体缺失属于八维完整性问题，由确定性规则 E2E-F-011 覆盖；
        // F-006 只在维度已声明但隔离不足时判定，避免对退化/未知输入误触发与重复报告。
        if (!di) continue;
        const isolation = di.isolation || '';
        const identities = Array.isArray(di.identities) ? di.identities : [];
        const testData = Array.isArray(di.test_data) ? di.test_data : [];
        const sharedState = di.shared_state || '';
        const parallelism = di.parallelism || {};
        const signals = [];
        if (!isolation || /^(?:none|shared|未隔离|无隔离|no[-_ ]?isolation|shared[-_ ]?state)$/i.test(isolation.trim())) {
          signals.push('isolation-none-or-missing');
        }
        if (identities.length === 0) signals.push('no-identity-isolation');
        if (testData.length === 0) signals.push('no-test-data-isolation');
        if (!parallelism.strategy) signals.push('no-repeated-run-strategy');
        if (sharedState && (!parallelism.strategy || parallelism.strategy === 'serial') && /^(?:none|shared|未隔离|无隔离)/i.test(isolation.trim() || 'none')) {
          signals.push('shared-state-without-isolation');
        }
        if (signals.length > 0) {
          findings.push(finding('E2E-F-006', item.case_id, `isolation insufficient: ${[...new Set(signals)].join(', ')}`, {
            severity: 'medium', repairability: 'business-decision',
            reviewerPacket: {
              rule: 'E2E-F-006',
              evaluated: { isolation_declared: Boolean(isolation), identities: identities.length, test_data: testData.length, parallelism_strategy: parallelism.strategy || null, shared_state: Boolean(sharedState) },
              signals: [...new Set(signals)],
              recommendation: 'introduce-unique-identity-data-partition-and-rerun-strategy',
              needs_human_review: true,
            },
          }));
        }
      }
      return findings;
    },
  },
  'E2E-F-010': {
    kind: 'semantic-review',
    detect(ctx) {
      const cases = ctx.matrix?.cases || [];
      const findings = [];
      // 只匹配"真实的固定等待"用法：具体调用形式（含数值参数）或明确的固定等待措辞。
      // 不匹配裸词（如 "不使用 sleep" 这类否定声明），避免误报。
      const FIXED_WAIT = /(?:thread\.sleep|time\.sleep|page\.waitForTimeout|waitForTimeout\s*\(|setTimeout\s*\(|setInterval\s*\(|cy\.wait\(\s*\d|\.delay\(\s*\d|sleep\s*\(?\s*\d|固定等待|强制等待|硬等待|fixed\s+wait|hard\s+wait)/i;
      const WAIT_NEGATION = /(?:不使用|不用|不采用|不依赖|避免|禁止|杜绝|without\s|avoid|never)/i;
      for (const item of cases) {
        // automation 整维缺失属于八维完整性问题，由 E2E-F-011 覆盖；F-010 只评估已声明的自动化维度。
        if (!item.automation) continue;
        const automation = item.automation;
        const stability = automation.stability || {};
        const flakeControls = Array.isArray(stability.flake_controls) ? stability.flake_controls : [];
        const waitStrategy = stability.wait_strategy || '';
        const retryPolicy = stability.retry_policy || '';
        const cost = automation.cost_level;
        const signals = [];
        if (flakeControls.length === 0) signals.push('no-stability-controls');
        if (waitStrategy && FIXED_WAIT.test(waitStrategy) && !WAIT_NEGATION.test(waitStrategy)) signals.push('fixed-wait-uncontrolled');
        if (cost === 'high' && flakeControls.length === 0) signals.push('high-cost-uncontrolled');
        if (signals.length > 0) {
          findings.push(finding('E2E-F-010', item.case_id, `instability uncontrolled: ${[...new Set(signals)].join(', ')}`, {
            severity: 'medium', repairability: 'business-decision',
            reviewerPacket: {
              rule: 'E2E-F-010',
              evaluated: { flake_controls: flakeControls.length, wait_strategy_declared: Boolean(waitStrategy), retry_policy_declared: Boolean(retryPolicy), cost_level: cost || null },
              signals: [...new Set(signals)],
              recommendation: 'use-event-driven-waits-retries-and-cost-controls',
              needs_human_review: true,
            },
          }));
        }
      }
      return findings;
    },
  },
  'E2E-F-012': {
    kind: 'deterministic',
    detect(ctx) {
      return validateProofBinding(ctx.proofBinding || { bindings: [] }, ctx.proofContext || {}).findings.filter(item => item.rule === 'E2E-F-012');
    },
  },
});

// M1-A（§5.2 req 3）：oracle/cleanup 的权威层在 matrix（MATRIX_FIELD_MANIFEST 声明
// authoritative: 'matrix'）。修复必须先落在 matrix 权威层，再由调用方重投影 artifact、
// 重绑 package manifest，构成单一摘要约束事务；只修 artifact 会破坏 round-trip。
// 兼容旧的 artifact-only 单元调用：未传 matrix 时退化为仅修 artifact 投影层。
export const REPAIR_HANDLERS = Object.freeze({
  'E2E-F-005': {
    apply(artifact, plan, findingItem, matrix) {
      const caseItem = artifact.test_cases?.find(item => item.case_id === findingItem.case_ref);
      if (!caseItem || !plan?.replacementOracle) return { fixed: false, reason: 'replacementOracle required' };
      const oracle = structuredClone(plan.replacementOracle);
      const matrixCase = matrix?.cases?.find(item => item.case_id === findingItem.case_ref);
      if (matrix && !matrixCase) return { fixed: false, reason: 'matrix case missing for repair target' };
      if (matrixCase) {
        matrixCase.oracle = {
          ...matrixCase.oracle,
          observable: oracle.observable,
          criterion: oracle.criterion,
          ...(oracle.timeout_ms === undefined ? {} : { timeout_ms: oracle.timeout_ms }),
        };
      }
      caseItem.oracles = [oracle];
      return { fixed: true, case_ref: findingItem.case_ref };
    },
  },
  'E2E-F-007': {
    apply(artifact, plan, findingItem, matrix) {
      const caseItem = artifact.test_cases?.find(item => item.case_id === findingItem.case_ref);
      if (!caseItem || !plan?.additionalCleanup?.length) return { fixed: false, reason: 'additionalCleanup required' };
      const matrixCase = matrix?.cases?.find(item => item.case_id === findingItem.case_ref);
      if (matrix && !matrixCase) return { fixed: false, reason: 'matrix case missing for repair target' };
      if (matrixCase) {
        const cleanup = matrixCase.cleanup || (matrixCase.cleanup = {});
        const steps = plan.additionalCleanup;
        cleanup.cleanup_steps = [...new Set([...(cleanup.cleanup_steps || []), ...(steps.filter(step => !/^(?:失败清理|补偿)：/.test(step)))])];
        cleanup.failure_cleanup = [...new Set([...(cleanup.failure_cleanup || []), ...steps.filter(step => step.startsWith('失败清理：')).map(step => step.slice('失败清理：'.length))])];
        cleanup.compensation = [...new Set([...(cleanup.compensation || []), ...steps.filter(step => step.startsWith('补偿：')).map(step => step.slice('补偿：'.length))])];
        if (!cleanup.failure_cleanup.length || !cleanup.compensation.length) {
          return { fixed: false, reason: 'matrix 权威层修复需要 failure_cleanup（"失败清理："前缀）与 compensation（"补偿："前缀）各至少一条' };
        }
        // 权威层已更新；artifact cleanup 由调用方经 projectCaseToArtifact 重投影派生。
        return { fixed: true, case_ref: findingItem.case_ref };
      }
      caseItem.cleanup = [...new Set([...(caseItem.cleanup || []), ...plan.additionalCleanup])];
      return { fixed: true, case_ref: findingItem.case_ref };
    },
  },
});
