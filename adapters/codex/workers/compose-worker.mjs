import { bindArtifactToMatrix, composeArtifact } from '../scripts/lib/matrix-dto.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';
import { validateSchema } from '../scripts/lib/schema-validation.mjs';

export const workerId = 'e2e-test/worker/compose@1';

export function runSync(input) {
  assertWorkerInput(input, 'compose');
  if (input.stageOutput !== undefined) throw Object.assign(new Error('compose does not accept stageOutput'), { code: 'STAGE_SCHEMA_INVALID' });
  const { matrix, assessment, inspection, packageContext } = input.inputs;
  const artifact = composeArtifact(matrix, assessment, { inspection });
  const contextRequired = ['artifactRef', 'matrixRef', 'familyApiRevisionDigest', 'contractRevisionDigest', 'stageChainDigest'];
  if (!packageContext || contextRequired.some(key => !packageContext[key])) throw Object.assign(new Error('package context incomplete'), { code: 'STAGE_SCHEMA_INVALID' });
  const manifest = bindArtifactToMatrix(artifact, matrix, packageContext);
  const manifestValidation = validateSchema(input.pluginRoot, 'artifact-package-manifest.json', manifest);
  if (!manifestValidation.valid) throw Object.assign(new Error(JSON.stringify(manifestValidation.errors)), { code: 'STAGE_SCHEMA_INVALID' });
  return finalizeWorkerResult(input, 'compose', workerId, {
    outputs: { artifact, matrix, manifest },
    intermediateFiles: { 'artifact.json': artifact, 'matrix.json': matrix, 'artifact-package-manifest.json': manifest },
  });
}

export async function run(input) {
  return runSync(input);
}
