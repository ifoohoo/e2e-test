import { validateArtifactPackageManifest, validateMatrixRoundTrip } from '../scripts/lib/matrix-dto.mjs';
import { validateProofBinding } from '../scripts/lib/proof-state.mjs';
import { validateArtifactContract } from '../scripts/lib/artifact-contract-validation.mjs';
import { assertWorkerInput, finalizeWorkerResult } from '../scripts/lib/worker-runtime.mjs';

export const workerId = 'e2e-test/worker/validate@1';

export function runSync(input) {
  assertWorkerInput(input, 'validate');
  if (input.stageOutput !== undefined) throw Object.assign(new Error('validate does not accept stageOutput'), { code: 'STAGE_SCHEMA_INVALID' });
  const { matrix, artifact, manifest, proofBinding, proofContext, artifactBytes, matrixBytes } = input.inputs;
  const roundTrip = validateMatrixRoundTrip(matrix, artifact, matrix);
  const packageValidation = validateArtifactPackageManifest(manifest, { artifact, matrix, artifactBytes, matrixBytes });
  const contractValidation = validateArtifactContract(input.pluginRoot, artifact, 'artifact.e2e-test@1');
  if (!contractValidation.valid) {
    const code = contractValidation.method === 'unavailable' ? 'ARTIFACT_GRAPH_UNAVAILABLE' : 'ARTIFACT_CONTRACT_INVALID';
    throw Object.assign(new Error(code), { code, contractValidation });
  }
  const proof = validateProofBinding(proofBinding, proofContext || {});
  const findings = [...proof.findings];
  if (!roundTrip.complete || !packageValidation.valid) findings.push({
    rule: 'E2E-F-011', severity: 'medium', repairability: 'safe-fix',
    description: '矩阵、制品或制品包 manifest 不一致', evidence: JSON.stringify({ roundTrip: roundTrip.missing, package: packageValidation.violations }),
  });
  const high = findings.some(item => item.severity === 'high');
  return finalizeWorkerResult(input, 'validate', workerId, {
    status: high ? 'FAIL' : 'PASS', findings,
    outputs: { valid: findings.length === 0, roundTrip, packageValidation, contractValidation, proof },
    intermediateFiles: { 'validation-result.json': { valid: findings.length === 0, findings } },
  });
}

export async function run(input) {
  return runSync(input);
}
