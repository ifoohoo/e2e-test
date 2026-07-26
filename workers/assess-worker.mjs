import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';
import { validateSchema } from '../scripts/lib/schema-validation.mjs';
import { validateAssessmentRationale } from '../scripts/lib/candidate-assessment.mjs';

export const workerId = 'e2e-test/worker/assess@1';

export function runSync(input) {
  assertWorkerInput(input, 'assess');
  if (input.stageOutput?.needs_input?.length) return finalizeWorkerResult(input, 'assess', workerId, {
    status: 'NEEDS_INPUT', outputs: {}, needsInput: input.stageOutput.needs_input,
  });
  const assessment = input.stageOutput;
  const validation = validateSchema(input.pluginRoot, 'candidate-assessment.json', assessment);
  if (!validation.valid) throw Object.assign(new Error(JSON.stringify(validation.errors)), { code: 'STAGE_SCHEMA_INVALID' });
  // WP1C：结构化充分理由的语义校验。缺理由已由 schema 失败关闭；此处进一步失败关闭
  // 「标签式理由」「重复 path_summary」等形式存在但实质未论证下层测试不足的候选，
  // 防止较窄协同路径被包装为 E2E。下沉项（DOWNSTREAM）不在此约束内，仍须保留。
  const rationale = validateAssessmentRationale(assessment);
  if (!rationale.valid) throw Object.assign(new Error(JSON.stringify(rationale.diagnostics)), { code: 'CANDIDATE_RATIONALE_INSUFFICIENT' });
  const inspection = input.inputs.inspection;
  if (!inspection || assessment.inspection_ref !== inspection.inspection_id) throw Object.assign(new Error('inspection_ref mismatch'), { code: 'STAGE_SCHEMA_INVALID' });
  return finalizeWorkerResult(input, 'assess', workerId, {
    outputs: { assessment }, intermediateFiles: { 'candidate-assessment.json': assessment },
  });
}

export async function run(input) {
  return runSync(input);
}
