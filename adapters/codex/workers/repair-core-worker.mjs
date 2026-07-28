import { applyRepairs } from '../scripts/lib/repair-kernel.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';

export const workerId = 'e2e-test/worker/repair-core@1';

// M1-A req 3/5：repair-core 与 standalone repair 共用统一内核 applyRepairs。
// oracle/cleanup 的权威层在 matrix；修复先落 matrix，再由后续 compose 重投影
// artifact 并重绑 package manifest，构成三件套单一摘要约束事务。
export function runSync(input) {
  assertWorkerInput(input, 'repair-core');
  const findings = input.inputs.findings || [];
  const plan = input.inputs.repairPlan || {};
  const outcome = applyRepairs(input.inputs.artifact, findings, plan, input.pluginRoot, input.inputs.matrix || null);
  const { artifact, matrix, repairs, needsInput } = outcome;
  if (needsInput.length) return finalizeWorkerResult(input, 'repair-core', workerId, {
    status: 'NEEDS_INPUT', outputs: { artifact, repairs }, needsInput,
  });
  return finalizeWorkerResult(input, 'repair-core', workerId, {
    outputs: { artifact, repairs },
    intermediateFiles: {
      'artifact.json': artifact,
      ...(matrix ? { 'matrix.json': matrix } : {}),
      'repair-results.json': { repairs },
    },
  });
}

export async function run(input) {
  return runSync(input);
}
