#!/usr/bin/env node

/** 汇总真实宿主直接执行的 service-runner 结果并生成场景证据。 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CHECK_IDS, createValidators, stableDigest } from './lib/behavior-qualification.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const host = value('--host');
const projectRootArg = value('--project-root');
const outputArg = value('--output');
if (!['codex', 'claude-code'].includes(host) || !isAbsolute(projectRootArg ?? '') || !outputArg ||
    isAbsolute(outputArg) || outputArg.split(/[\\/]+/).includes('..')) blocked('VERIFY_ARGUMENTS_INVALID');
const projectRoot = resolve(projectRootArg);
const outputPath = resolve(projectRoot, outputArg);
if (relative(projectRoot, outputPath).startsWith('..')) blocked('VERIFY_OUTPUT_UNSAFE');

const preparedPath = join(projectRoot, 'qualification-control', 'prepared.json');
if (!existsSync(preparedPath)) blocked('PREPARED_EVIDENCE_MISSING');
const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
const preparedDigest = prepared.digest;
const { digest: _digest, ...preparedUnsigned } = prepared;
if (prepared.host !== host || stableDigest(preparedUnsigned) !== preparedDigest) blocked('PREPARED_EVIDENCE_INVALID');

const protectedStable = prepared.protectedFiles.every(item => {
  const path = resolve(projectRoot, item.path);
  return !relative(projectRoot, path).startsWith('..') && existsSync(path) && digestBytes(readFileSync(path)) === item.digest;
});
const markerPath = join(projectRoot, 'qualification-control', 'business-command.ok');
const businessCommandComplete = existsSync(markerPath) && readFileSync(markerPath, 'utf8') === 'BUSINESS_COMMAND_COMPLETE\n';
const results = Object.fromEntries([...CHECK_IDS, 'business-review'].map(id => [id, readTrial(id)]));
const emptyDelta = { added: [], removed: [], modified: [] };
const checks = [];
add('help', 'HELP_READY', 0, false, emptyDelta);
add('author-no-binding', 'NOT_ENABLED', 1, false, emptyDelta);
add('review-no-binding', 'NOT_ENABLED', 1, false, emptyDelta);
add('repair-no-binding', 'NOT_ENABLED', 1, false, emptyDelta);
// M1-A req 6：proof-binding 是 author 的第 4 个正式交付物。
add('author', 'AUTHOR_COMPLETE', 0, true, { added: ['artifacts/e2e/authored.json', 'artifacts/e2e/authored.matrix.json', 'artifacts/e2e/authored.package.json', 'artifacts/e2e/authored.proof.json'], removed: [], modified: [] });
add('review', 'REVIEW_COMPLETE', 0, true, { added: ['reviews/oracle-review.json'], removed: [], modified: [] }, ['E2E-F-005', true], protectedStable);
// M1-A req 3：repair 三件套（artifact/matrix/package manifest）同步落盘。
add('repair', 'REPAIR_COMPLETE', 0, true, { added: ['artifacts/e2e/repaired.json', 'artifacts/e2e/repaired.matrix.json', 'artifacts/e2e/repaired.package.json'], removed: [], modified: [] }, ['E2E-F-005', false]);
add('re-review', 'REVIEW_COMPLETE', 0, true, emptyDelta, ['E2E-F-005', false]);
add('business-decision', 'REPAIR_NEEDS_INPUT', 0, true, emptyDelta);
add('bundle-drift', 'BUNDLE_DIGEST_MISMATCH', 1, false, emptyDelta);
add('host-swap', 'HOST_MISMATCH', 1, false, emptyDelta);
add('caller-lock', 'CALLER_LOCK_REJECTED', 1, false, emptyDelta);
add('default-write-reject', 'METHOD_QUERY_REJECTED', 1, false, emptyDelta);

const businessFinding = hasFinding(results['business-review'], 'E2E-F-004');
const businessNeedsInput = results['business-decision']?.status === 'NEEDS_INPUT';
if (!businessFinding || !businessNeedsInput) checks.find(check => check.id === 'business-decision').status = 'FAIL';
if (results.author?.contractValidation?.valid !== true) checks.find(check => check.id === 'author').status = 'FAIL';
if (!protectedStable || !businessCommandComplete) for (const check of checks) check.status = 'FAIL';

const fixtureNames = ['artifact.json', 'candidate-assessment.json', 'inspection.json', 'matrix.json'];
const scenario = {
  schemaVersion: 1,
  host,
  status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
  identity: {
    familyApiRevision: prepared.identity.familyApiRevision,
    contractRevision: prepared.identity.contractRevision,
    implementationId: prepared.identity.implementationId,
    implementationVersion: prepared.identity.implementationVersion,
    qualificationInputTarballDigest: prepared.identity.qualificationInputTarballDigest,
    qualificationSubjectDigest: prepared.identity.qualificationSubjectDigest,
    bundleDigest: prepared.identity.bundleDigest,
    deterministicAttestation: prepared.identity.deterministicAttestation,
    fixtureDigests: fixtureNames.map(name => ({ name, digest: digestBytes(readFileSync(join(projectRoot, 'fixtures', name))) })),
  },
  checks,
};
scenario.digest = stableDigest(scenario);
const validators = createValidators(join(pluginRoot, 'schemas'));
if (!validators.scenario(scenario)) blocked('SCENARIO_SCHEMA_INVALID');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(scenario, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status: scenario.status === 'PASS' ? 'SCENARIO_COMPLETE' : 'SCENARIO_FAILED',
  host, result: outputArg.replaceAll('\\', '/'), digest: scenario.digest,
})}\n`);
process.exit(scenario.status === 'PASS' ? 0 : 1);

function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function blocked(code) { process.stdout.write(`${JSON.stringify({ status: 'SCENARIO_BLOCKED', code })}\n`); process.exit(1); }
function readTrial(id) {
  const path = join(projectRoot, 'qualification-results', 'trials', `${id}.json`);
  if (!existsSync(path)) return { status: 'MISSING', code: 'TRIAL_RESULT_MISSING' };
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { status: 'INVALID', code: 'TRIAL_RESULT_INVALID' }; }
}
function hasFinding(result, rule) { return result?.reviewResult?.findings?.some(finding => finding.rule === rule) === true; }
function add(id, code, exitCode, lock, filesystemDelta, finding = null, inputDigestStable = null) {
  const result = results[id];
  const check = {
    hostId: host, id, status: 'PASS', exitCode, code,
    runLockReverified: result?.runLock?.filesystemReverified === true,
    finding: finding ? { rule: finding[0], present: hasFinding(result, finding[0]) } : null,
    filesystemDelta, inputDigestStable,
  };
  if (result?.code !== code || (lock && !check.runLockReverified) || (!lock && check.runLockReverified) ||
      (finding && check.finding.present !== finding[1])) check.status = 'FAIL';
  checks.push(check);
}
function digestBytes(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
