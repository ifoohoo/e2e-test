import { reconcileCases } from '../scripts/lib/proof-state.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';
import { validateSchema } from '../scripts/lib/schema-validation.mjs';

export const workerId = 'e2e-test/worker/reconcile@1';

export function runSync(input) {
  assertWorkerInput(input, 'reconcile');
  if (input.stageOutput !== undefined) throw Object.assign(new Error('reconcile does not accept stageOutput'), { code: 'STAGE_SCHEMA_INVALID' });
  const proofBinding = reconcileCases(input.inputs.matrix, input.inputs.artifact, input.inputs.proofContext || {});
  const validation = validateSchema(input.pluginRoot, 'proof-binding.json', proofBinding);
  if (!validation.valid) throw Object.assign(new Error(JSON.stringify(validation.errors)), { code: 'PROOF_STATE_INVALID' });
  return finalizeWorkerResult(input, 'reconcile', workerId, {
    outputs: { proofBinding }, intermediateFiles: { 'proof-binding.json': proofBinding },
  });
}

export async function run(input) {
  return runSync(input);
}
