#!/usr/bin/env node

/**
 * 安装包内的确定性行为资格场景执行器。
 *
 * 本脚本不替代 Codex/Claude 宿主资格；它是宿主读取技能后必须调用的
 * 唯一确定性业务入口。外层 harness 负责证明宿主确实读取了 SKILL.md、
 * 执行了本脚本，并验证这里生成的结构化证据。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  deriveConsistentSet, loadRoundTripBase, repairOutputSet, threeArtifactRefs, writeThreeArtifactSet,
} from './lib/three-artifact-fixtures.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const require = createRequire(join(pluginRoot, 'package.json'));
const args = process.argv.slice(2);
const hostArg = valueOf('--host');
const projectRootArg = valueOf('--project-root');
const outputArg = valueOf('--output');

if (!['codex', 'claude-code'].includes(hostArg) || !projectRootArg || !outputArg) {
  emitBlocked('INVALID_SCENARIO_ARGUMENTS');
}

const projectRoot = resolve(projectRootArg);
if (!isAbsolute(projectRootArg) || !existsSync(projectRoot)) emitBlocked('PROJECT_ROOT_INVALID');
if (isAbsolute(outputArg) || outputArg.split(/[\\/]+/).some(part => part === '..')) emitBlocked('OUTPUT_PATH_UNSAFE');
const outputPath = resolve(projectRoot, outputArg);
if (relative(projectRoot, outputPath).startsWith('..')) emitBlocked('OUTPUT_PATH_UNSAFE');

const serviceRunner = join(pluginRoot, 'scripts', 'service-runner.mjs');
const apiSnapshot = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
const descriptorText = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
const packageJsonBytes = readFileSync(join(pluginRoot, 'package.json'));
const packageDigest = digestBytes(packageJsonBytes);
const contractRevisionDigest = resolveContractRevision();
const treeDigest = scalar('treeDigest');
const deterministicAttestation = scalar('deterministicAttestation');
const implementationVersion = topScalar('version');
const implementationId = topScalar('familyImplementationId');
const pluginId = topScalar('pluginId');

if (!isDigest(contractRevisionDigest) || !isDigest(treeDigest) || !isDigest(deterministicAttestation)) {
  emitBlocked('AUTHORITY_IDENTITY_INVALID');
}

const requestsDir = join(projectRoot, 'requests');
const fixturesDir = join(projectRoot, 'fixtures');
const artifactsDir = join(projectRoot, 'artifacts', 'e2e');
const reviewsDir = join(projectRoot, 'reviews');
for (const dir of [requestsDir, fixturesDir, artifactsDir, reviewsDir]) mkdirSync(dir, { recursive: true });
seedFixtures();

const identity = {
  familyApiRevision: apiSnapshot.api.revisionDigest,
  contractRevision: contractRevisionDigest,
  implementationId,
  implementationVersion,
  qualificationInputTarballDigest: packageDigest,
  qualificationSubjectDigest: packageDigest,
  bundleDigest: treeDigest,
  deterministicAttestation,
  fixtureDigests: fixtureDigests(),
};

const emptyDelta = { added: [], removed: [], modified: [] };
const checks = [];
runHelp();
runNoBinding('author');
runNoBinding('review');
runNoBinding('repair');
runAuthor();
if (!existsSync(join(artifactsDir, 'authored.json'))) emitBlocked('AUTHOR_PREREQUISITE_FAILED');
runReview();
runRepair();
runRereview();
runBusinessDecision();
runMutation('bundle-drift', request => {
  request.binding.bindings[0].providerSelector.bundleDigest = `sha256:${'0'.repeat(64)}`;
}, 'BUNDLE_DIGEST_MISMATCH');
runMutation('host-swap', request => {
  request.binding.bindings[0].providerSelector.host = hostArg === 'codex' ? 'claude-code' : 'codex';
}, 'HOST_MISMATCH');
runMutation('caller-lock', request => {
  request.runLock = { queryDigest: `sha256:${'e'.repeat(64)}`, filesystemReverified: true };
}, 'CALLER_LOCK_REJECTED');
runDefaultWriteReject();

const scenario = {
  schemaVersion: 1,
  host: hostArg,
  status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
  identity,
  checks,
};
scenario.digest = stableDigest(scenario);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(scenario, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  status: scenario.status === 'PASS' ? 'SCENARIO_COMPLETE' : 'SCENARIO_FAILED',
  host: hostArg,
  result: outputArg.replaceAll('\\', '/'),
  digest: scenario.digest,
})}\n`);
process.exit(scenario.status === 'PASS' ? 0 : 1);

function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function emitBlocked(code) {
  process.stdout.write(`${JSON.stringify({ status: 'SCENARIO_BLOCKED', code })}\n`);
  process.exit(1);
}

function topScalar(name) {
  return descriptorText.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
}

function scalar(name) {
  return descriptorText.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
}

function resolveContractRevision() {
  const candidates = [];
  if (process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND && isAbsolute(process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND)) {
    candidates.push(process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND);
  }
  try {
    const entry = require.resolve('artifact-graph');
    candidates.push(join(dirname(entry), 'cli.js'));
  } catch {}
  for (const command of candidates) {
    if (!existsSync(command)) continue;
    try {
      const stdout = execFileSync(process.execPath, [
        command, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json',
      ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      const parsed = JSON.parse(stdout);
      const revision = parsed?.data?.identity?.revisionDigest;
      if (parsed?.ok === true && isDigest(revision)) return revision;
    } catch {}
  }
  return null;
}

function seedFixtures() {
  const positive = join(pluginRoot, 'fixtures', 'positive');
  for (const name of ['inspection.json', 'candidate-assessment.json', 'matrix.json', 'artifact.json']) {
    writeFileSync(join(fixturesDir, name), readFileSync(join(positive, name)));
  }
}

function fixtureDigests() {
  return readdirSync(fixturesDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({ name, digest: digestBytes(readFileSync(join(fixturesDir, name))) }));
}

function projectFacts() {
  const content = {
    schemaVersion: 1,
    projectRoot,
    configDigest: `sha256:${'c'.repeat(64)}`,
    policyDigest: null,
    artifactGraphSummary: { artifactCount: 3, edgeCount: 2, contextTargets: ['feature'] },
    targetArtifact: { type: 'feature', id: 'F-001' },
    contractRevisionDigest,
    proofStatus: 'present',
    versionLockStatus: 'fresh',
    sourcesFreshness: 'fresh',
    bindingFreshness: 'fresh',
  };
  return { ...content, evidenceDigest: stableDigest(content) };
}

function binding(sideEffectBudget) {
  return {
    documentKind: 'v2-binding',
    schemaVersion: 2,
    bindings: [{
      familyId: 'e2e-test',
      apiIdentity: {
        apiId: apiSnapshot.api.id,
        apiMajor: apiSnapshot.api.major,
        apiRevisionDigest: apiSnapshot.api.revisionDigest,
      },
      implementationIdentity: { familyImplementationId: implementationId, version: implementationVersion },
      providerSelector: {
        scope: 'plugin', pluginId, host: hostArg, canonicalRoot: pluginRoot,
        packageDigest, bundleDigest: treeDigest, provenance: 'qualification-tarball',
      },
      selectionSource: 'project-binding',
      conformanceEvidence: { deterministicAttestation, behaviorQualification: null },
      authorization: { sideEffectBudget, granted: true },
    }],
  };
}

function baseRequest(service, sideEffectBudget) {
  return {
    service,
    host: hostArg,
    projectRoot,
    installation: { packageDigest, provenance: 'qualification-tarball' },
    binding: binding(sideEffectBudget),
    projectFacts: projectFacts(),
    authorization: { sideEffectBudget, granted: true },
  };
}

function authorRequest() {
  const output = 'artifacts/e2e/authored.json';
  return {
    ...baseRequest('author', 'write-authorized-artifacts'),
    inputs: {
      inspection: 'fixtures/inspection.json',
      assessment: 'fixtures/candidate-assessment.json',
      matrix: 'fixtures/matrix.json',
    },
    output,
    writeSet: authorWriteSet(output),
  };
}

function authorWriteSet(output) {
  return [output, output.replace(/\.json$/, '.matrix.json'), output.replace(/\.json$/, '.package.json'), output.replace(/\.json$/, '.proof.json')];
}

function invoke(id, request) {
  const requestPath = join(requestsDir, `${id}.json`);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  try {
    const stdout = execFileSync(process.execPath, [serviceRunner, '--request', requestPath, '--json'], {
      cwd: pluginRoot, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { exitCode: 0, body: JSON.parse(stdout) };
  } catch (error) {
    try {
      return { exitCode: Number.isInteger(error.status) ? error.status : 1, body: JSON.parse(error.stdout || '{}') };
    } catch {
      return { exitCode: 1, body: { status: 'BLOCKED', code: 'UNPARSEABLE_SERVICE_OUTPUT' } };
    }
  }
}

function snapshotOutputs() {
  const result = {};
  for (const root of [join(projectRoot, 'artifacts'), join(projectRoot, 'reviews')]) walk(root, result);
  return result;
}

function walk(root, output) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, output);
    else if (stat.isFile()) output[relative(projectRoot, full).replaceAll('\\', '/')] = digestBytes(readFileSync(full));
  }
}

function delta(before, after) {
  return {
    added: Object.keys(after).filter(path => !(path in before)).sort(),
    removed: Object.keys(before).filter(path => !(path in after)).sort(),
    modified: Object.keys(after).filter(path => path in before && after[path] !== before[path]).sort(),
  };
}

function addCheck(id, result, oracle) {
  const check = {
    hostId: hostArg,
    id,
    status: 'FAIL',
    exitCode: result.exitCode,
    code: result.body?.code ?? null,
    runLockReverified: result.body?.runLock?.filesystemReverified === true,
    finding: null,
    filesystemDelta: oracle.filesystemDelta,
    inputDigestStable: oracle.inputDigestStable ?? null,
  };
  const findingRule = oracle.findingRule;
  if (findingRule) {
    const present = result.body?.reviewResult?.findings?.some(finding => finding.rule === findingRule) === true;
    check.finding = { rule: findingRule, present };
  }
  const codeOk = result.body?.code === oracle.code;
  const exitOk = oracle.exitCode === result.exitCode;
  const lockOk = oracle.requireRunLock ? check.runLockReverified : true;
  const findingOk = !findingRule || check.finding.present === oracle.findingPresent;
  const deltaOk = JSON.stringify(check.filesystemDelta) === JSON.stringify(oracle.expectedDelta);
  const inputOk = oracle.inputDigestStable === undefined || oracle.inputDigestStable === true;
  if (codeOk && exitOk && lockOk && findingOk && deltaOk && inputOk) check.status = 'PASS';
  checks.push(check);
}

function runHelp() {
  const before = snapshotOutputs();
  const result = invoke('help', { service: 'help' });
  const filesystemDelta = delta(before, snapshotOutputs());
  addCheck('help', result, {
    code: 'HELP_READY', exitCode: 0, expectedDelta: emptyDelta, filesystemDelta,
  });
  const last = checks.at(-1);
  if (result.body?.discovery?.userEntry !== 'artifact-chain-assistant:where-am-i' || JSON.stringify(last.filesystemDelta) !== JSON.stringify(emptyDelta)) last.status = 'FAIL';
}

function runNoBinding(service) {
  const request = baseRequest(service, service === 'review' ? 'write-review-result' : 'write-authorized-artifacts');
  delete request.binding;
  if (service === 'author') Object.assign(request, authorRequest(), { binding: undefined });
  if (service === 'review') Object.assign(request, { inputArtifact: 'fixtures/artifact.json', writeSet: [] });
  if (service === 'repair') Object.assign(request, {
    inputArtifact: 'fixtures/artifact.json', output: 'artifacts/e2e/no-binding-repair.json',
    writeSet: ['artifacts/e2e/no-binding-repair.json'], repairPlan: { 'E2E-F-005': { replacementOracle: '用户看到成功状态' } },
  });
  delete request.binding;
  const before = snapshotOutputs();
  const result = invoke(`${service}-no-binding`, request);
  addCheck(`${service}-no-binding`, result, { code: 'NOT_ENABLED', exitCode: 1, expectedDelta: emptyDelta, filesystemDelta: delta(before, snapshotOutputs()) });
}

function runAuthor() {
  const before = snapshotOutputs();
  const initialRequest = authorRequest();
  const initial = invoke('author-initialize', initialRequest);
  if (initial.exitCode !== 0 || initial.body?.code !== 'AUTHOR_STAGE_READY' || initial.body?.stage !== 'compose') emitBlocked('AUTHOR_INITIALIZE_FAILED');
  let current = initial;
  for (const stage of ['compose', 'review-core', 'repair-core', 'reconcile', 'validate']) {
    current = invoke(`author-${stage}`, {
      ...baseRequest('author', 'write-authorized-artifacts'),
      runId: initial.body.runId,
      stage,
      ...(stage === 'reconcile' ? { runnerInventory: { playwright: { active: true } } } : {}),
    });
    const expected = stage === 'validate' ? 'AUTHOR_PREVIEW_READY' : 'AUTHOR_STAGE_READY';
    if (current.exitCode !== 0 || current.body?.code !== expected) emitBlocked(`AUTHOR_${stage.replace('-', '_').toUpperCase()}_FAILED`);
  }
  const preview = current.body;
  const result = invoke('author', {
    ...baseRequest('author', 'write-authorized-artifacts'),
    mode: 'commit', writeSet: initialRequest.writeSet,
    commit: { runId: initial.body.runId, handleId: preview.preview?.commitHandle?.handleId },
  });
  addCheck('author', result, {
    code: 'AUTHOR_COMPLETE', exitCode: 0, requireRunLock: true,
    // M1-A req 6：proof-binding 是第 4 个正式交付物。
    expectedDelta: { added: ['artifacts/e2e/authored.json', 'artifacts/e2e/authored.matrix.json', 'artifacts/e2e/authored.package.json', 'artifacts/e2e/authored.proof.json'], removed: [], modified: [] },
    filesystemDelta: delta(before, snapshotOutputs()),
  });
  if (result.body?.contractValidation?.valid !== true) checks.at(-1).status = 'FAIL';
}

function runReview() {
  // M1-A req 1/3：从 authored 三件套派生 internal-oracle 负例——在 matrix 权威层注入、
  // 重投影 artifact、重绑 manifest，保持三件套 round-trip / 摘要一致。
  const authored = JSON.parse(readFileSync(join(artifactsDir, 'authored.json'), 'utf8'));
  const authoredMatrix = JSON.parse(readFileSync(join(artifactsDir, 'authored.matrix.json'), 'utf8'));
  const authoredManifest = JSON.parse(readFileSync(join(artifactsDir, 'authored.package.json'), 'utf8'));
  const set = deriveConsistentSet(authored, authoredMatrix, matrix => {
    matrix.cases[0].oracle.observable = 'SQL SELECT status FROM orders WHERE id = current_order';
  });
  writeThreeArtifactSet(projectRoot, 'fixtures/internal-oracle-artifact.json', set, {
    packageId: authoredManifest.packageId,
    familyApiMajor: authoredManifest.familyApi.major,
    familyApiRevisionDigest: authoredManifest.familyApi.revisionDigest,
    contractRevisionDigest: authoredManifest.subject.contractRevisionDigest,
    artifactMediaType: authoredManifest.subject.mediaType,
    stageChainDigest: authoredManifest.stageChainDigest,
  });
  const input = join(fixturesDir, 'internal-oracle-artifact.json');
  const beforeInput = digestBytes(readFileSync(input));
  const before = snapshotOutputs();
  const result = invoke('review', {
    ...baseRequest('review', 'write-review-result'),
    ...threeArtifactRefs('fixtures/internal-oracle-artifact.json'),
    output: 'reviews/oracle-review.json', writeSet: ['reviews/oracle-review.json'],
  });
  const inputStable = beforeInput === digestBytes(readFileSync(input));
  addCheck('review', result, {
    code: 'REVIEW_COMPLETE', exitCode: 0, requireRunLock: true,
    findingRule: 'E2E-F-005', findingPresent: true, inputDigestStable: inputStable,
    expectedDelta: { added: ['reviews/oracle-review.json'], removed: [], modified: [] },
    filesystemDelta: delta(before, snapshotOutputs()),
  });
}

function runRepair() {
  const before = snapshotOutputs();
  // M1-A req 3：repair 三件套同步输出（artifact + matrix + package manifest）。
  const outputs = repairOutputSet('artifacts/e2e/repaired.json');
  const request = {
    ...baseRequest('repair', 'write-authorized-artifacts'),
    ...threeArtifactRefs('fixtures/internal-oracle-artifact.json'), reviewResult: 'reviews/oracle-review.json',
    ...outputs,
    repairPlan: { 'E2E-F-005': { replacementOracle: {
      observable: '用户看到订单确认页显示支付成功', criterion: '订单状态显示为已支付', timeout_ms: 10000,
    } } },
  };
  const preview = invoke('repair-preview', request);
  if (preview.exitCode !== 0 || preview.body?.code !== 'REPAIR_PREVIEW_READY') emitBlocked('REPAIR_PREVIEW_FAILED');
  const result = invoke('repair', {
    ...baseRequest('repair', 'write-authorized-artifacts'), mode: 'commit', writeSet: request.writeSet,
    commit: { runId: preview.body.runId, handleId: preview.body.preview?.commitHandle?.handleId },
  });
  addCheck('repair', result, {
    code: 'REPAIR_COMPLETE', exitCode: 0, requireRunLock: true,
    findingRule: 'E2E-F-005', findingPresent: false,
    expectedDelta: { added: [...outputs.writeSet].sort(), removed: [], modified: [] },
    filesystemDelta: delta(before, snapshotOutputs()),
  });
}

function runRereview() {
  const before = snapshotOutputs();
  const result = invoke('re-review', {
    ...baseRequest('review', 'write-review-result'),
    ...threeArtifactRefs('artifacts/e2e/repaired.json'), writeSet: [],
  });
  addCheck('re-review', result, {
    code: 'REVIEW_COMPLETE', exitCode: 0, requireRunLock: true,
    findingRule: 'E2E-F-005', findingPresent: false,
    expectedDelta: emptyDelta, filesystemDelta: delta(before, snapshotOutputs()),
  });
}

function runBusinessDecision() {
  // M1-A req 1/3：happy-only 负例以三件套派生（matrix 权威层过滤 → 重投影 → 重绑）。
  const happy = loadRoundTripBase(pluginRoot);
  deriveConsistentSet(happy.artifact, happy.matrix, matrix => {
    matrix.cases = matrix.cases.filter(caseItem => caseItem.path.path_class === 'happy');
  });
  writeThreeArtifactSet(projectRoot, 'fixtures/happy-only-artifact.json', happy, {
    familyApiRevisionDigest: apiSnapshot.api.revisionDigest,
    contractRevisionDigest,
    stageChainDigest: `sha256:${'d'.repeat(64)}`,
  });
  const review = invoke('business-review', {
    ...baseRequest('review', 'write-review-result'), ...threeArtifactRefs('fixtures/happy-only-artifact.json'),
    output: 'reviews/business-review.json', writeSet: ['reviews/business-review.json'],
  });
  const hasFinding = review.body?.reviewResult?.findings?.some(finding => finding.rule === 'E2E-F-004') === true;
  const before = snapshotOutputs();
  const result = invoke('business-decision', {
    ...baseRequest('repair', 'write-authorized-artifacts'),
    ...threeArtifactRefs('fixtures/happy-only-artifact.json'), reviewResult: 'reviews/business-review.json',
    ...repairOutputSet('artifacts/e2e/business-repair.json'),
    repairPlan: { 'E2E-F-004': {} },
  });
  addCheck('business-decision', result, {
    code: 'REPAIR_NEEDS_INPUT', exitCode: 0, expectedDelta: emptyDelta,
    filesystemDelta: delta(before, snapshotOutputs()),
  });
  if (!hasFinding || result.body?.status !== 'NEEDS_INPUT') checks.at(-1).status = 'FAIL';
}

function runMutation(id, mutate, expectedCode) {
  const request = authorRequest();
  request.output = `artifacts/e2e/${id}.json`;
  request.writeSet = authorWriteSet(request.output);
  mutate(request);
  const before = snapshotOutputs();
  const result = invoke(id, request);
  addCheck(id, result, { code: expectedCode, exitCode: 1, expectedDelta: emptyDelta, filesystemDelta: delta(before, snapshotOutputs()) });
}

function runDefaultWriteReject() {
  const request = authorRequest();
  request.service = 'default';
  request.intent = 'author';
  request.output = 'artifacts/e2e/default-write.json';
  request.writeSet = authorWriteSet(request.output);
  request.authorization = { sideEffectBudget: 'read-only', granted: true };
  const before = snapshotOutputs();
  const result = invoke('default-write-reject', request);
  addCheck('default-write-reject', result, {
    code: 'METHOD_QUERY_REJECTED', exitCode: 1, expectedDelta: emptyDelta,
    filesystemDelta: delta(before, snapshotOutputs()),
  });
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableDigest(value) {
  return digestBytes(JSON.stringify(canonicalize(value)));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}
