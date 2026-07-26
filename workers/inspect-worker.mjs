import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';
import { validateSchema } from '../scripts/lib/schema-validation.mjs';

export const workerId = 'e2e-test/worker/inspect@1';

export function runSync(input) {
  assertWorkerInput(input, 'inspect');
  if (input.stageOutput?.needs_input?.length) return finalizeWorkerResult(input, 'inspect', workerId, {
    status: 'NEEDS_INPUT', outputs: {}, needsInput: input.stageOutput.needs_input,
  });
  const inspection = input.stageOutput;
  const validation = validateSchema(input.pluginRoot, 'inspection.json', inspection);
  if (!validation.valid) throw Object.assign(new Error(JSON.stringify(validation.errors)), { code: 'STAGE_SCHEMA_INVALID' });
  const requiredSources = new Set(input.inputs?.sourceRefs || []);
  const observed = new Set(inspection.inputs?.source_ids || []);
  if ([...requiredSources].some(ref => !observed.has(ref))) throw Object.assign(new Error('inspection did not cover all sources'), { code: 'STAGE_SCHEMA_INVALID' });
  return finalizeWorkerResult(input, 'inspect', workerId, {
    outputs: { inspection }, intermediateFiles: { 'inspection.json': inspection },
  });
}

export async function run(input) {
  return runSync(input);
}
