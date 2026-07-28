#!/usr/bin/env node

/** 为真实宿主行为资格准备不可变 fixtures 与 service-runner requests。 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  deriveConsistentSet, loadRoundTripBase, repairOutputSet, threeArtifactRefs, writeThreeArtifactSet,
} from './lib/three-artifact-fixtures.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const host = value('--host');
const projectRootArg = value('--project-root');
const qualificationInputTarballDigest = value('--qualification-input-tarball-digest');
const qualificationSubjectDigest = value('--qualification-subject-digest');
const artifactGraphCommand = value('--artifact-graph-command');
if (!['codex', 'claude-code'].includes(host) || !isAbsolute(projectRootArg ?? '') ||
    !isDigest(qualificationInputTarballDigest) || !isDigest(qualificationSubjectDigest) ||
    !isAbsolute(artifactGraphCommand ?? '')) blocked('PREPARE_ARGUMENTS_INVALID');

const projectRoot = resolve(projectRootArg);
const descriptor = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
const api = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
const identity = {
  familyApiRevision: api.api.revisionDigest,
  contractRevision: explainContract(),
  implementationId: topScalar('familyImplementationId'),
  implementationVersion: topScalar('version'),
  pluginId: topScalar('pluginId'),
  qualificationInputTarballDigest,
  qualificationSubjectDigest,
  bundleDigest: nestedScalar('treeDigest'),
  deterministicAttestation: nestedScalar('deterministicAttestation'),
};
if (Object.entries(identity).some(([key, item]) => key !== 'pluginId' && key !== 'implementationId' && key !== 'implementationVersion' && !isDigest(item))) {
  blocked('PREPARE_IDENTITY_INVALID');
}

const requestsDir = join(projectRoot, 'requests');
const fixturesDir = join(projectRoot, 'fixtures');
const controlDir = join(projectRoot, 'qualification-control');
for (const path of [requestsDir, fixturesDir, controlDir, join(projectRoot, 'artifacts', 'e2e'), join(projectRoot, 'reviews'), join(projectRoot, 'qualification-results', 'trials')]) {
  mkdirSync(path, { recursive: true });
}
seedFixtures();
seedSemanticFixtures();

writeRequest('help', { service: 'help' });
for (const service of ['author', 'review', 'repair']) writeRequest(`${service}-no-binding`, noBindingRequest(service));
writeRequest('author', authorRequest());
writeRequest('review', {
  ...baseRequest('review', 'write-review-result'), ...threeArtifactRefs('fixtures/internal-oracle-artifact.json'),
  output: 'reviews/oracle-review.json', writeSet: ['reviews/oracle-review.json'],
});
writeRequest('repair', {
  ...baseRequest('repair', 'write-authorized-artifacts'), ...threeArtifactRefs('fixtures/internal-oracle-artifact.json'),
  reviewResult: 'reviews/oracle-review.json', ...repairOutputSet('artifacts/e2e/repaired.json'),
  repairPlan: { 'E2E-F-005': { replacementOracle: {
    observable: '用户看到订单确认页显示支付成功', criterion: '订单状态显示为已支付', timeout_ms: 10000,
  } } },
});
writeRequest('re-review', {
  ...baseRequest('review', 'write-review-result'), ...threeArtifactRefs('artifacts/e2e/repaired.json'), writeSet: [],
});
writeRequest('business-review', {
  ...baseRequest('review', 'write-review-result'), ...threeArtifactRefs('fixtures/happy-only-artifact.json'),
  output: 'reviews/business-review.json', writeSet: ['reviews/business-review.json'],
});
writeRequest('business-decision', {
  ...baseRequest('repair', 'write-authorized-artifacts'), ...threeArtifactRefs('fixtures/happy-only-artifact.json'),
  reviewResult: 'reviews/business-review.json', ...repairOutputSet('artifacts/e2e/business-repair.json'),
  repairPlan: { 'E2E-F-004': {} },
});
writeMutation('bundle-drift', request => { request.binding.bindings[0].providerSelector.bundleDigest = `sha256:${'0'.repeat(64)}`; });
writeMutation('host-swap', request => { request.binding.bindings[0].providerSelector.host = host === 'codex' ? 'claude-code' : 'codex'; });
writeMutation('caller-lock', request => { request.runLock = { queryDigest: `sha256:${'e'.repeat(64)}`, filesystemReverified: true }; });
const defaultRequest = authorRequest();
defaultRequest.service = 'default';
defaultRequest.intent = 'author';
defaultRequest.output = 'artifacts/e2e/default-write.json';
defaultRequest.writeSet = authorWriteSet(defaultRequest.output);
defaultRequest.authorization = { sideEffectBudget: 'read-only', granted: true };
writeRequest('default-write-reject', defaultRequest);

const protectedFiles = collectFiles([requestsDir, fixturesDir]).map(path => ({
  path: relative(projectRoot, path).replaceAll('\\', '/'), digest: digestBytes(readFileSync(path)),
}));
const prepared = { schemaVersion: 1, host, identity, protectedFiles };
prepared.digest = stableDigest(prepared);
writeFileSync(join(controlDir, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'QUALIFICATION_PREPARED', host, digest: prepared.digest })}\n`);

function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function blocked(code) { process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code })}\n`); process.exit(1); }
function topScalar(name) { return descriptor.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null; }
function nestedScalar(name) { return descriptor.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null; }
function isDigest(input) { return typeof input === 'string' && /^sha256:[a-f0-9]{64}$/.test(input); }

function explainContract() {
  if (!existsSync(artifactGraphCommand)) blocked('ARTIFACT_GRAPH_COMMAND_MISSING');
  try {
    const output = execFileSync(process.execPath, [artifactGraphCommand, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output);
    if (result.ok === true && isDigest(result.data?.identity?.revisionDigest)) return result.data.identity.revisionDigest;
  } catch {}
  blocked('ARTIFACT_CONTRACT_UNAVAILABLE');
}

function seedFixtures() {
  const source = join(pluginRoot, 'fixtures', 'positive');
  for (const name of ['inspection.json', 'candidate-assessment.json', 'matrix.json', 'artifact.json']) {
    writeFileSync(join(fixturesDir, name), readFileSync(join(source, name)));
  }
}

function seedSemanticFixtures() {
  // M1-A req 1/3：语义 fixtures 以三件套形式落盘（matrix 权威层变异 → 重投影 → 重绑），
  // 使 review/repair 的 round-trip / 摘要 / 引用一致性校验可以通过。
  const bindContext = {
    familyApiRevisionDigest: identity.familyApiRevision,
    contractRevisionDigest: identity.contractRevision,
    stageChainDigest: `sha256:${'d'.repeat(64)}`,
  };
  const internal = loadRoundTripBase(pluginRoot);
  deriveConsistentSet(internal.artifact, internal.matrix, matrix => {
    matrix.cases[0].oracle.observable = 'SQL SELECT status FROM orders WHERE id = current_order';
  });
  writeThreeArtifactSet(projectRoot, 'fixtures/internal-oracle-artifact.json', internal, bindContext);
  const happy = loadRoundTripBase(pluginRoot);
  deriveConsistentSet(happy.artifact, happy.matrix, matrix => {
    matrix.cases = matrix.cases.filter(caseItem => caseItem.path.path_class === 'happy');
  });
  writeThreeArtifactSet(projectRoot, 'fixtures/happy-only-artifact.json', happy, bindContext);
}

function projectFacts() {
  const facts = {
    schemaVersion: 1, projectRoot, configDigest: `sha256:${'c'.repeat(64)}`, policyDigest: null,
    artifactGraphSummary: { artifactCount: 3, edgeCount: 2, contextTargets: ['feature'] },
    targetArtifact: { type: 'feature', id: 'F-001' }, contractRevisionDigest: identity.contractRevision,
    proofStatus: 'present', versionLockStatus: 'fresh', sourcesFreshness: 'fresh', bindingFreshness: 'fresh',
  };
  return { ...facts, evidenceDigest: stableDigest(facts) };
}

function binding(sideEffectBudget) {
  return {
    documentKind: 'v2-binding', schemaVersion: 2,
    bindings: [{
      familyId: 'e2e-test',
      apiIdentity: { apiId: api.api.id, apiMajor: api.api.major, apiRevisionDigest: identity.familyApiRevision },
      implementationIdentity: { familyImplementationId: identity.implementationId, version: identity.implementationVersion },
      providerSelector: { scope: 'plugin', pluginId: identity.pluginId, host, canonicalRoot: pluginRoot, packageDigest: qualificationInputTarballDigest, bundleDigest: identity.bundleDigest, provenance: 'qualification-tarball' },
      selectionSource: 'project-binding',
      conformanceEvidence: { deterministicAttestation: identity.deterministicAttestation, behaviorQualification: null },
      authorization: { sideEffectBudget, granted: true },
    }],
  };
}

function baseRequest(service, sideEffectBudget) {
  return {
    service, host, projectRoot, installation: { packageDigest: qualificationInputTarballDigest, provenance: 'qualification-tarball' },
    binding: binding(sideEffectBudget), projectFacts: projectFacts(),
    authorization: { sideEffectBudget, granted: true },
  };
}

function authorRequest() {
  const output = 'artifacts/e2e/authored.json';
  return {
    ...baseRequest('author', 'write-authorized-artifacts'),
    inputs: { inspection: 'fixtures/inspection.json', assessment: 'fixtures/candidate-assessment.json', matrix: 'fixtures/matrix.json' },
    output, writeSet: authorWriteSet(output),
  };
}

function authorWriteSet(output) {
  return [output, output.replace(/\.json$/, '.matrix.json'), output.replace(/\.json$/, '.package.json'), output.replace(/\.json$/, '.proof.json')];
}

function noBindingRequest(service) {
  let request;
  if (service === 'author') request = authorRequest();
  else if (service === 'review') request = { ...baseRequest('review', 'write-review-result'), inputArtifact: 'fixtures/artifact.json', writeSet: [] };
  else request = {
    ...baseRequest('repair', 'write-authorized-artifacts'), inputArtifact: 'fixtures/artifact.json',
    output: 'artifacts/e2e/no-binding-repair.json', writeSet: ['artifacts/e2e/no-binding-repair.json'],
    repairPlan: { 'E2E-F-005': { replacementOracle: '用户看到成功状态' } },
  };
  delete request.binding;
  return request;
}

function writeMutation(id, mutate) {
  const request = authorRequest();
  request.output = `artifacts/e2e/${id}.json`;
  request.writeSet = authorWriteSet(request.output);
  mutate(request);
  writeRequest(id, request);
}

function writeRequest(id, request) {
  writeFileSync(join(requestsDir, `${id}.json`), `${JSON.stringify(request, null, 2)}\n`);
}

function collectFiles(roots) {
  const output = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) output.push(...collectFiles([path]));
      else if (entry.isFile()) output.push(path);
    }
  }
  return output.sort();
}

function digestBytes(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function stableDigest(input) { return digestBytes(JSON.stringify(canonicalize(input))); }
function canonicalize(input) {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(canonicalize);
  return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonicalize(input[key])]));
}
