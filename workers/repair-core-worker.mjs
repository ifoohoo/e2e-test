import { loadFindingManifest } from '../scripts/lib/finding-manifest.mjs';
import { REPAIR_HANDLERS } from '../scripts/lib/finding-handlers.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';

export const workerId = 'e2e-test/worker/repair-core@1';

export function runSync(input) {
  assertWorkerInput(input, 'repair-core');
  const artifact = structuredClone(input.inputs.artifact);
  const findings = input.inputs.findings || [];
  const plan = input.inputs.repairPlan || {};
  const { rules } = loadFindingManifest(input.pluginRoot);
  const needsInput = [];
  const repairs = [];
  for (const finding of findings) {
    const capability = rules.get(finding.rule);
    const handler = REPAIR_HANDLERS[finding.rule];
    if (!capability || capability.repairability !== 'safe-fix' || !handler) {
      needsInput.push({ field: finding.rule, reason: '该 finding 需要业务决策、外部处理或尚无安全修复处理器' });
      continue;
    }
    const result = handler.apply(artifact, plan[finding.rule], finding);
    repairs.push({ rule: finding.rule, ...result });
    if (!result.fixed) needsInput.push({ field: finding.rule, reason: result.reason || '修复计划不足' });
  }
  if (needsInput.length) return finalizeWorkerResult(input, 'repair-core', workerId, {
    status: 'NEEDS_INPUT', outputs: { artifact, repairs }, needsInput,
  });
  return finalizeWorkerResult(input, 'repair-core', workerId, {
    outputs: { artifact, repairs }, intermediateFiles: { 'artifact.json': artifact, 'repair-results.json': { repairs } },
  });
}

export async function run(input) {
  return runSync(input);
}
