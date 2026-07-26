import { FINDING_HANDLERS } from '../scripts/lib/finding-handlers.mjs';
import { loadFindingManifest } from '../scripts/lib/finding-manifest.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';

export const workerId = 'e2e-test/worker/review-core@1';

export function runSync(input) {
  assertWorkerInput(input, 'review-core');
  const context = input.inputs.context || input.inputs;
  const findings = Object.values(FINDING_HANDLERS).flatMap(handler => handler.detect(context));
  const { rules } = loadFindingManifest(input.pluginRoot);
  for (const item of input.stageOutput?.semanticFindings || []) {
    if (rules.get(item.rule)?.status !== 'semantic-review') throw Object.assign(new Error(`semantic handler unavailable for ${item.rule}`), { code: 'MANIFEST_HANDLER_MISMATCH' });
    findings.push(item);
  }
  return finalizeWorkerResult(input, 'review-core', workerId, {
    outputs: { findings }, findings, intermediateFiles: { 'review-findings.json': { findings } },
  });
}

export async function run(input) {
  return runSync(input);
}
