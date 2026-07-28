import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { stableDigest } from './digest.mjs';
import { expectedPriorStage, STAGE_ORDER } from './stage-pipeline.mjs';
import { validateSchema } from './schema-validation.mjs';

const ABSOLUTE_PATTERNS = [/(?:^|[\s"'])(?:\/[A-Za-z0-9._-]+){2,}/, /[A-Za-z]:\\/];

export function assertNoAbsolutePath(value) {
  if (typeof value === 'string') return !ABSOLUTE_PATTERNS.some(pattern => pattern.test(value));
  if (Array.isArray(value)) return value.every(assertNoAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).every(assertNoAbsolutePath);
  return true;
}

export function verifyPriorDigests(stageResult) {
  const priorStage = expectedPriorStage(stageResult.stage);
  if (!priorStage) return { valid: true, violation: null };
  const prior = stageResult.inputs?.prior;
  const valid = Boolean(
    prior
    && prior.stage === priorStage
    && prior.status === 'PASS'
    && prior.nextStage === stageResult.stage
    && isDigest(prior.inputDigest)
    && isDigest(prior.outputDigest)
    && isDigest(prior.resultDigest),
  );
  return { valid, violation: valid ? null : 'STAGE_PRIOR_DIGEST_MISMATCH' };
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function verifyWriteSetContainment(runRoot, stageResult) {
  const failures = [];
  for (const file of stageResult.writeSet || []) {
    if (isAbsolute(file) || file.startsWith('..') || file.includes('\0')) { failures.push(file); continue; }
    const root = resolve(runRoot, 'outputs');
    const target = resolve(root, file);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { failures.push(file); continue; }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      const real = realpathSync(target);
      const realRel = relative(root, real);
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) failures.push(file);
    }
  }
  return { valid: failures.length === 0, failures };
}

export function verifyResumeDigests(stageResult, files = {}) {
  if (!stageResult.resumedFrom) return { valid: true, violation: null };
  const current = files[stageResult.resumedFrom.stage];
  const valid = Boolean(current
    && stableDigest(current.inputs || {}) === stageResult.resumedFrom.inputDigest
    && stableDigest(current.outputs || {}) === stageResult.resumedFrom.outputDigest);
  return { valid, violation: valid ? null : 'RESUME_DIGEST_MISMATCH' };
}

export function validateStageResult(runRoot, stage, { pluginRoot = resolve(import.meta.dirname, '..', '..') } = {}) {
  const checks = [];
  const diagnostics = [];
  if (!STAGE_ORDER.includes(stage)) return { status: 'FAIL', checks, diagnostics: [{ code: 'STAGE_ORDER_VIOLATION', severity: 'error' }] };
  const resultFile = join(runRoot, 'stage-results', `${stage}.json`);
  if (!existsSync(resultFile)) return { status: 'ERROR', checks, diagnostics: [{ code: 'RUN_ROOT_INVALID', severity: 'error' }] };
  let result;
  try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch {
    return { status: 'ERROR', checks, diagnostics: [{ code: 'RUN_ROOT_INVALID', severity: 'error' }] };
  }
  const schema = validateSchema(pluginRoot, 'stage-result.json', result);
  checks.push({ name: 'schema', status: schema.valid ? 'PASS' : 'FAIL', deterministic: true, error: schema.valid ? null : 'STAGE_SCHEMA_INVALID' });
  if (!schema.valid) diagnostics.push({ code: 'STAGE_SCHEMA_INVALID', severity: 'error' });
  const digests = result.inputDigest === stableDigest(result.inputs || {}) && result.outputDigest === stableDigest(result.outputs || {});
  checks.push({ name: 'digests', status: digests ? 'PASS' : 'FAIL', deterministic: true, error: digests ? null : 'STAGE_PRIOR_DIGEST_MISMATCH' });
  if (!digests) diagnostics.push({ code: 'STAGE_PRIOR_DIGEST_MISMATCH', severity: 'error' });
  const prior = verifyPriorDigests(result);
  checks.push({ name: 'prior', status: prior.valid ? 'PASS' : 'FAIL', deterministic: true, error: prior.violation });
  if (!prior.valid) diagnostics.push({ code: prior.violation, severity: 'error' });
  const containment = verifyWriteSetContainment(runRoot, result);
  checks.push({ name: 'write-set', status: containment.valid ? 'PASS' : 'FAIL', deterministic: true, error: containment.valid ? null : 'STAGE_WRITE_SET_ESCAPE' });
  if (!containment.valid) diagnostics.push({ code: 'STAGE_WRITE_SET_ESCAPE', severity: 'error' });
  const noLeak = assertNoAbsolutePath({ outputs: result.outputs, findings: result.findings, needs_input: result.needs_input, writeSet: result.writeSet });
  checks.push({ name: 'no-absolute-path', status: noLeak ? 'PASS' : 'FAIL', deterministic: true, error: noLeak ? null : 'STAGE_WRITE_SET_ESCAPE' });
  if (!noLeak) diagnostics.push({ code: 'STAGE_WRITE_SET_ESCAPE', severity: 'error' });
  return { validator: stage, status: diagnostics.length ? 'FAIL' : 'PASS', checks, diagnostics, result };
}

export function stageValidatorCli(stage, argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--run-root');
  const runRoot = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  const json = argv.includes('--json');
  const expectedIndex = argv.indexOf('--expect-status');
  const expected = expectedIndex >= 0 ? argv[expectedIndex + 1] : null;
  if (!runRoot || !existsSync(runRoot)) {
    const output = { validator: stage, status: 'ERROR', checks: [], diagnostics: [{ code: 'RUN_ROOT_INVALID', severity: 'error' }] };
    console.log(json ? JSON.stringify(output) : `${stage}: ERROR RUN_ROOT_INVALID`);
    return 2;
  }
  const output = validateStageResult(runRoot, stage);
  if (expected && output.result?.status !== expected) {
    output.status = 'FAIL';
    output.diagnostics.push({ code: 'UNEXPECTED_STAGE_STATUS', severity: 'error' });
  }
  const publicOutput = { validator: output.validator, status: output.status, checks: output.checks, diagnostics: output.diagnostics };
  console.log(json ? JSON.stringify(publicOutput) : `${stage}: ${output.status}`);
  return output.status === 'PASS' ? 0 : 1;
}
