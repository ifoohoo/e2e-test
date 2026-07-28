import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';
import { validateSchema } from '../scripts/lib/schema-validation.mjs';
import { validateRecoveryDeterminism } from '../scripts/lib/matrix-dto.mjs';

export const workerId = 'e2e-test/worker/design@1';

export function runSync(input) {
  assertWorkerInput(input, 'design');
  const matrix = input.stageOutput;
  const validation = validateSchema(input.pluginRoot, 'matrix.json', matrix);
  if (!validation.valid) throw Object.assign(new Error(JSON.stringify(validation.errors)), { code: 'STAGE_SCHEMA_INVALID' });
  const assessment = input.inputs.assessment;
  if (!assessment || matrix.assessment_ref !== assessment.assessment_id) throw Object.assign(new Error('assessment_ref mismatch'), { code: 'STAGE_SCHEMA_INVALID' });
  const hasHappy = matrix.cases.some(item => item.path.path_class === 'happy');
  const hasRisk = matrix.cases.some(item => ['error', 'recovery', 'security'].includes(item.path.path_class));
  const waived = matrix.cases.some(item => item.value_risk.waiver);
  if (!hasHappy || !hasRisk && !waived) return finalizeWorkerResult(input, 'design', workerId, {
    status: 'NEEDS_INPUT', outputs: { matrix },
    findings: [{ rule: 'E2E-F-004', severity: 'high', description: '关键 happy/risk 路径不完整且无结构化 waiver', repairability: 'business-decision' }],
    needsInput: [{ field: 'matrix.cases', reason: '补充关键 happy 与 error/recovery/security 路径，或提供结构化 waiver' }],
  });
  // WP1D：可可靠机械检查的恢复确定性失败关闭。每种故障注入必须分别有确定性恢复动作，
  // 不得用“若曾注入/注入过则”逃避逐故障绑定；命中即 NEEDS_INPUT，正向试验驱动据此失败关闭。
  const recovery = validateRecoveryDeterminism(matrix);
  if (!recovery.valid) return finalizeWorkerResult(input, 'design', workerId, {
    status: 'NEEDS_INPUT', outputs: { matrix },
    findings: recovery.findings,
    needsInput: recovery.findings.map(item => ({ field: `matrix.cases[${item.case_ref}].cleanup`, reason: item.description })),
  });
  return finalizeWorkerResult(input, 'design', workerId, {
    outputs: { matrix }, intermediateFiles: { 'matrix.json': matrix },
  });
}

export async function run(input) {
  return runSync(input);
}
