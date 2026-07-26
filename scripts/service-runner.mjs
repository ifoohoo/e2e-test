#!/usr/bin/env node

/**
 * E2E Test family unified service entry.
 *
 * Gate-B service runtime: help is read-only; every other service must pass the
 * Registry public producer → query → strict resolve → run-lock reverify chain
 * before entering the shared deterministic business dispatch.
 *
 * Key design (trust kernel convergence R4+R5):
 * - Reads Family API identity from shipped authority-api/api.json (not hardcoded)
 * - Cross-validates API identity with descriptor's implements section
 * - Passes full ProjectFactsEvidenceEnvelope to Registry (provider does not re-derive content digest)
 * - Structured diagnostics only: no raw Error.message, no path regex sanitizer
 * - Help distinguishes an importable Registry package from a compatible 0.2
 *   runtime, then reports providerInstallation, familyEnablement, trust and
 *   qualification independently. No `registry.installed` object confusion.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTruthKernel } from './lib/truthfulness-kernel.mjs';
import { loadFindingManifest, stableBlocked } from './lib/finding-manifest.mjs';

const pluginRoot = realpathSync(join(import.meta.dirname, '..'));
const require = createRequire(join(pluginRoot, 'package.json'));
const args = process.argv.slice(2);
const requestIndex = args.indexOf('--request');
const requestPath = requestIndex >= 0 ? args[requestIndex + 1] : null;
const jsonMode = args.includes('--json');

// Read Family API identity from authoritative snapshot (not hardcoded)
const familyApiSnapshotPath = join(pluginRoot, 'authority-api', 'api.json');
let SNAPSHOT_API_ID, SNAPSHOT_API_MAJOR, SNAPSHOT_API_REVISION;
try {
  const snapshot = JSON.parse(readFileSync(familyApiSnapshotPath, 'utf8'));
  SNAPSHOT_API_ID = snapshot.api.id;
  SNAPSHOT_API_MAJOR = snapshot.api.major;
  SNAPSHOT_API_REVISION = snapshot.api.revisionDigest;
} catch {
  // Fatal: cannot read authority snapshot
  process.stdout.write(JSON.stringify({
    status: 'BLOCKED', code: 'SNAPSHOT_UNAVAILABLE', service: null,
    diagnostics: [{ code: 'SNAPSHOT_UNAVAILABLE', severity: 'error' }],
  }) + '\n');
  process.exit(1);
}

// Read descriptor for cross-validation
const descriptorPath = join(pluginRoot, 'family', 'implementation.yaml');
const descriptorText = readFileSync(descriptorPath, 'utf8');
const DESCRIPTOR_API_ID = descriptorText.match(/^\s*apiId:\s*(.+)$/m)?.[1]?.trim();
const DESCRIPTOR_API_MAJOR = Number(descriptorText.match(/^\s*apiMajor:\s*(.+)$/m)?.[1]?.trim());
const DESCRIPTOR_API_REVISION = descriptorText.match(/^\s*apiRevisionDigest:\s*(.+)$/m)?.[1]?.trim();

// Cross-validate: snapshot and descriptor must agree on API identity
if (DESCRIPTOR_API_ID !== SNAPSHOT_API_ID || DESCRIPTOR_API_MAJOR !== SNAPSHOT_API_MAJOR || DESCRIPTOR_API_REVISION !== SNAPSHOT_API_REVISION) {
  process.stdout.write(JSON.stringify({
    status: 'BLOCKED', code: 'API_IDENTITY_DRIFT', service: null,
    diagnostics: [{ code: 'API_IDENTITY_DRIFT', severity: 'error' }],
  }) + '\n');
  process.exit(1);
}

const CONTRACT_ID = 'artifact.e2e-test@1';
const artifactContractIdentity = resolveArtifactContractIdentity();
const CONTRACT_REVISION = artifactContractIdentity.revisionDigest;
const HOSTS = new Set(['codex', 'claude-code']);
const SERVICE_NAMES = new Set(['help', 'default', 'author', 'review', 'repair']);
const REF_BY_SERVICE = Object.fromEntries([...SERVICE_NAMES].map(name => [name, `artifact.e2e-test.${name}`]));
const REQUIRED_REGISTRY_API = [
  'buildEffectiveIndex',
  'queryEffectiveIndex',
  'resolveEntry',
  'verifyProvider',
];

// ─── Structured Error (R5: no raw messages exposed) ───
class ServiceError extends Error {
  constructor(code, diagnostics = []) {
    super(code);
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// Stable diagnostic codes for all failure modes
const DIAGNOSTICS = {
  REQUEST_REQUIRED: { code: 'REQUEST_REQUIRED', severity: 'error' },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', severity: 'error' },
  CALLER_LOCK_REJECTED: { code: 'CALLER_LOCK_REJECTED', severity: 'error' },
  UNKNOWN_SERVICE: { code: 'UNKNOWN_SERVICE', severity: 'error' },
  HOST_MISMATCH: { code: 'HOST_MISMATCH', severity: 'error' },
  HOST_REQUIRED: { code: 'HOST_REQUIRED', severity: 'error' },
  PROJECT_ROOT_INVALID: { code: 'PROJECT_ROOT_INVALID', severity: 'error' },
  PROJECT_FACTS_REQUIRED: { code: 'PROJECT_FACTS_REQUIRED', severity: 'error' },
  PROJECT_FACTS_DRIFT: { code: 'PROJECT_FACTS_DRIFT', severity: 'error' },
  AUTHORIZATION_REQUIRED: { code: 'AUTHORIZATION_REQUIRED', severity: 'error' },
  AUTHORIZATION_DENIED: { code: 'AUTHORIZATION_DENIED', severity: 'error' },
  INVENTORY_FACTS_REQUIRED: { code: 'INVENTORY_FACTS_REQUIRED', severity: 'error' },
  NOT_ENABLED: { code: 'NOT_ENABLED', severity: 'error' },
  BINDING_INVALID: { code: 'BINDING_INVALID', severity: 'error' },
  PARTIAL_BINDING_REJECTED: { code: 'PARTIAL_BINDING_REJECTED', severity: 'error' },
  BINDING_IDENTITY_MISMATCH: { code: 'BINDING_IDENTITY_MISMATCH', severity: 'error' },
  PROVIDER_ROOT_INVALID: { code: 'PROVIDER_ROOT_INVALID', severity: 'error' },
  PROVIDER_ROOT_MISMATCH: { code: 'PROVIDER_ROOT_MISMATCH', severity: 'error' },
  PACKAGE_IDENTITY_MISMATCH: { code: 'PACKAGE_IDENTITY_MISMATCH', severity: 'error' },
  BUNDLE_DIGEST_MISMATCH: { code: 'BUNDLE_DIGEST_MISMATCH', severity: 'error' },
  ATTESTATION_MISMATCH: { code: 'ATTESTATION_MISMATCH', severity: 'error' },
  REGISTRY_UNAVAILABLE: { code: 'REGISTRY_UNAVAILABLE', severity: 'error' },
  ARTIFACT_GRAPH_UNAVAILABLE: { code: 'ARTIFACT_GRAPH_UNAVAILABLE', severity: 'error' },
  REGISTRY_API_INCOMPATIBLE: { code: 'REGISTRY_API_INCOMPATIBLE', severity: 'error' },
  PROJECTION_REJECTED: { code: 'PROJECTION_REJECTED', severity: 'error' },
  SERVICE_CONTRACT_MISSING: { code: 'SERVICE_CONTRACT_MISSING', severity: 'error' },
  METHOD_QUERY_REJECTED: { code: 'METHOD_QUERY_REJECTED', severity: 'error' },
  SERVICE_NOT_RESOLVABLE: { code: 'SERVICE_NOT_RESOLVABLE', severity: 'error' },
  STRICT_RESOLVE_REJECTED: { code: 'STRICT_RESOLVE_REJECTED', severity: 'error' },
  RUN_LOCK_REVERIFY_REJECTED: { code: 'RUN_LOCK_REVERIFY_REJECTED', severity: 'error' },
  PREFLIGHT_FAILED: { code: 'PREFLIGHT_FAILED', severity: 'error' },
  MANIFEST_INVALID: { code: 'MANIFEST_INVALID', severity: 'error' },
};

let request;
try {
  if (!requestPath) throw new ServiceError('REQUEST_REQUIRED');
  request = JSON.parse(readFileSync(requestPath, 'utf8'));
} catch (error) {
  const code = error instanceof ServiceError ? error.code : 'INVALID_REQUEST';
  emitFailure(new ServiceError(code, [DIAGNOSTICS[code] || DIAGNOSTICS.INVALID_REQUEST]));
}

if (!request || typeof request !== 'object' || Array.isArray(request)) {
  emitFailure(new ServiceError('INVALID_REQUEST', [DIAGNOSTICS.INVALID_REQUEST]));
}
if ('runLock' in request || 'runMethodLock' in request || 'lock' in request) {
  emitFailure(new ServiceError('CALLER_LOCK_REJECTED', [DIAGNOSTICS.CALLER_LOCK_REJECTED]));
}
if (!SERVICE_NAMES.has(request.service)) {
  emitFailure(new ServiceError('UNKNOWN_SERVICE', [DIAGNOSTICS.UNKNOWN_SERVICE]));
}

if (request.service === 'help' || (request.service === 'default' && request.intent === 'help')) {
  const registry = await tryLoadRegistry();
  const artifactGraph = await tryLoadArtifactGraph();
  const kernel = createTruthKernel(pluginRoot);
  const kernelStatus = await kernel.verify();
  // Finding capability manifest is the single source of truth for F001~F012;
  // help must expose the same manifest-derived view gate-status reports.
  let findingCapability;
  try {
    findingCapability = loadFindingManifest(pluginRoot);
  } catch {
    emitFailure(new ServiceError('MANIFEST_INVALID', [DIAGNOSTICS.MANIFEST_INVALID]));
  }
  const trustStatus = kernelStatus.providerInstallation.status === 'consistent'
    && kernelStatus.conformance.status === 'pass'
    && kernelStatus.qualification.status === 'qualified'
    ? 'PROVEN' : 'NOT_PROVEN';
  const conformanceStatus = kernelStatus.conformance.status === 'pass' ? 'PASS' : 'FAIL';
  const qualificationStatus = kernelStatus.qualification.status === 'qualified'
    ? 'QUALIFIED' : 'NOT_QUALIFIED';
  emitSuccess({
    status: 'AVAILABLE',
    code: 'HELP_READY',
    service: 'help',
    ...(request.service === 'default' ? { routedFrom: 'default' } : {}),
    capabilities: [
      { service: 'default', purpose: 'intent routing', enabled: false, trust: trustStatus, qualification: qualificationStatus },
      { service: 'author', purpose: 'author E2E specifications', enabled: false, trust: trustStatus, qualification: qualificationStatus },
      { service: 'review', purpose: 'review E2E specifications', enabled: false, trust: trustStatus, qualification: qualificationStatus },
      { service: 'repair', purpose: 'repair reviewed specifications', enabled: false, trust: trustStatus, qualification: qualificationStatus },
    ],
    findingCapabilities: {
      digest: findingCapability.digest,
      implemented: [...findingCapability.rules.values()].filter(item => item.status !== 'planned').map(item => item.rule),
      planned: [...findingCapability.rules.values()].filter(item => item.status === 'planned').map(item => item.rule),
      stableBlocked: stableBlocked(findingCapability.manifest),
    },
    contracts: {
      artifact: { id: CONTRACT_ID, revisionDigest: CONTRACT_REVISION },
      familyApi: { id: `${SNAPSHOT_API_ID}@${SNAPSHOT_API_MAJOR}`, revisionDigest: SNAPSHOT_API_REVISION },
    },
    registryRuntimeAvailable: Boolean(registry.api),
    registryRuntimeCompatible: isRegistryApiCompatible(registry.api, registry.version),
    artifactGraphRuntimeAvailable: Boolean(artifactGraph.api),
    artifactContractAvailable: Boolean(CONTRACT_REVISION),
    providerInstallation: kernelStatus.providerInstallation.status === 'consistent' ? 'PROVEN' : 'NOT_PROVEN',
    conformance: conformanceStatus,
    familyEnablement: kernelStatus.familyEnablement.status === 'enabled' ? 'ENABLED' : 'NOT_ENABLED',
    trust: trustStatus,
    qualification: qualificationStatus,
    qualifications: {
      operational: kernelStatus.qualifications.operational.status,
      methodForward: kernelStatus.qualifications.methodForward.status,
      methodForwardPendingMarkers: kernelStatus.qualifications.methodForward.pendingMarkers,
      releaseArtifact: kernelStatus.qualifications.releaseArtifact,
    },
    discovery: {
      userEntry: 'artifact-chain-assistant:where-am-i',
      machineRegistry: 'agent-method-registry',
      next: '先由 where-am-i 基于当前项目事实推荐下一项制品工作，再显式启用并绑定本技能族。',
    },
    minimalExamples: [
      { intent: 'author', result: '生成 artifact.e2e-test@1 规格并执行 contract/review 门禁' },
      { intent: 'review', result: '只读返回结构化 Review Result' },
      { intent: 'repair', result: '仅对已授权 safe-fix 生成修复副本' },
    ],
    diagnostics: [],
  });
}

// Business dispatch: preflight → dispatch.
// `default` is only an intent router. Once it identifies a concrete business
// service, that target service must pass its own Registry query and side-effect
// authorization; the read-only default ceiling must never authorize writes.
const routedIntent = request.service === 'default' && ['author', 'review', 'repair'].includes(
  typeof request.intent === 'string' ? request.intent.toLowerCase().trim() : '',
)
  ? request.intent.toLowerCase().trim()
  : null;
const executionRequest = routedIntent
  ? { ...request, service: routedIntent }
  : request;

let preflightResult;
try {
  preflightResult = await runPreflight(executionRequest);
} catch (error) {
  const code = error instanceof ServiceError ? error.code : 'PREFLIGHT_FAILED';
  const diagnostics = error instanceof ServiceError ? error.diagnostics : [DIAGNOSTICS.PREFLIGHT_FAILED];
  emitFailure(new ServiceError(code, diagnostics), routedIntent || request.service);
}

// Merge preflight context into request and dispatch to business logic
let result;
try {
  const { dispatch } = await import('./service-dispatch.mjs');
  const dispatchRequest = {
    ...executionRequest,
    _preflight: { ref: preflightResult.ref, status: preflightResult.status, code: preflightResult.code },
    _runLock: preflightResult.runLock,
  };
  result = dispatch(dispatchRequest, request.projectRoot);
  if (routedIntent && result) result.routedFrom = 'default';
  // Attach runLock and preflight info from the verified chain
  if (result && !result.runLock) result.runLock = preflightResult.runLock;
  if (result && !result.preflight) result.preflight = { ref: preflightResult.ref, status: preflightResult.status };
} catch (error) {
  // Dispatch module error — report but don't expose internals
  result = {
    status: 'BLOCKED',
    code: 'DISPATCH_ERROR',
    service: request.service,
    diagnostics: [{ code: 'DISPATCH_ERROR', severity: 'error' }],
    runLock: preflightResult?.runLock || null,
  };
}
// commitSecret 仅供同进程测试/宿主内存调用；CLI JSON 永不序列化秘密原文。
if (result && Object.hasOwn(result, 'commitSecret')) delete result.commitSecret;
emitSuccess(result);

async function runPreflight(input) {
  if (!HOSTS.has(input.host)) throw new ServiceError(input.host ? 'HOST_MISMATCH' : 'HOST_REQUIRED', [input.host ? DIAGNOSTICS.HOST_MISMATCH : DIAGNOSTICS.HOST_REQUIRED]);
  if (!input.projectRoot || !isAbsolute(input.projectRoot) || !existsSync(input.projectRoot)) {
    throw new ServiceError('PROJECT_ROOT_INVALID', [DIAGNOSTICS.PROJECT_ROOT_INVALID]);
  }
  if (!input.projectFacts?.targetArtifact?.type || !input.projectFacts?.targetArtifact?.id) {
    throw new ServiceError('PROJECT_FACTS_REQUIRED', [DIAGNOSTICS.PROJECT_FACTS_REQUIRED]);
  }
  if (!CONTRACT_REVISION) {
    throw new ServiceError('ARTIFACT_GRAPH_UNAVAILABLE', [{ code: 'ARTIFACT_GRAPH_UNAVAILABLE', severity: 'error' }]);
  }
  // Full ProjectFactsEvidenceEnvelope required (provider does not re-derive content digest)
  if (!input.projectFacts || typeof input.projectFacts !== 'object' || !input.projectFacts.schemaVersion || !input.projectFacts.projectRoot) {
    throw new ServiceError('PROJECT_FACTS_REQUIRED', [DIAGNOSTICS.PROJECT_FACTS_REQUIRED]);
  }
  // Contract revision must match (early reject before Registry)
  if (input.projectFacts.contractRevisionDigest !== CONTRACT_REVISION) {
    throw new ServiceError('PROJECT_FACTS_DRIFT', [DIAGNOSTICS.PROJECT_FACTS_DRIFT]);
  }

  const registryLoad = await tryLoadRegistry();
  const registry = registryLoad.api;

  if (!input.authorization || typeof input.authorization.granted !== 'boolean') {
    throw new ServiceError('AUTHORIZATION_REQUIRED', [DIAGNOSTICS.AUTHORIZATION_REQUIRED]);
  }
  if (!input.authorization.granted) throw new ServiceError('AUTHORIZATION_DENIED', [DIAGNOSTICS.AUTHORIZATION_DENIED]);
  if (!isDigest(input.installation?.packageDigest) || !input.installation?.provenance) {
    throw new ServiceError('INVENTORY_FACTS_REQUIRED', [DIAGNOSTICS.INVENTORY_FACTS_REQUIRED]);
  }
  validateExactBinding(input.binding, input);

  if (!registry) {
    const loadResult = await tryLoadRegistry();
    throw new ServiceError('REGISTRY_UNAVAILABLE', [DIAGNOSTICS.REGISTRY_UNAVAILABLE]);
  }
  if (!isRegistryApiCompatible(registry, registryLoad.version)) {
    throw new ServiceError('REGISTRY_API_INCOMPATIBLE', [DIAGNOSTICS.REGISTRY_API_INCOMPATIBLE]);
  }

  // Read from authoritative snapshot (already validated at startup)
  const familyApi = JSON.parse(readFileSync(familyApiSnapshotPath, 'utf8'));
  const implementation = parseImplementation(descriptorText);
  const inventoryEntry = {
    pluginId: implementation.pluginId,
    canonicalRoot: pluginRoot,
    version: implementation.version,
    packageDigest: input.installation.packageDigest,
    provenance: input.installation.provenance,
    host: input.host,
  };

  const projectionResult = registry.buildEffectiveIndex({
    familyApi,
    implementations: [implementation],
    inventoryEntries: [inventoryEntry],
    bindings: input.binding,
  });
  if (!projectionResult.ok || !projectionResult.index || !projectionResult.preparedInventory) {
    throw registryFailure('PROJECTION_REJECTED', projectionResult.diagnostics);
  }

  const serviceDef = familyApi.services.find(service => service.id === REF_BY_SERVICE[input.service]);
  if (!serviceDef) throw new ServiceError('SERVICE_CONTRACT_MISSING', [DIAGNOSTICS.SERVICE_CONTRACT_MISSING]);

  const queryResult = registry.queryEffectiveIndex({
    index: projectionResult.index,
    methodQueryCandidate: {
      mode: 'standard',
      intent: serviceDef.intents[0],
      kind: serviceDef.kind,
      projectFactsEvidence: input.projectFacts,
      authorization: input.authorization,
    },
    purpose: 'prepare',
  });
  if (!queryResult.ok || !queryResult.preparedQueryHandle) {
    throw registryFailure('METHOD_QUERY_REJECTED', queryResult.diagnostics);
  }

  const serviceIdentity = queryResult.preparedQueryHandle.candidateServices
    .find(candidate => candidate.serviceId === serviceDef.id);
  if (!serviceIdentity) throw new ServiceError('SERVICE_NOT_RESOLVABLE', [DIAGNOSTICS.SERVICE_NOT_RESOLVABLE]);

  const resolveResult = registry.resolveEntry({
    host: input.host,
    index: projectionResult.index,
    ref: serviceDef.id,
    pluginRoots: { [implementation.pluginId]: [pluginRoot] },
    preparedQueryHandle: queryResult.preparedQueryHandle,
    serviceIdentity,
    strictProvider: true,
  });
  if (!resolveResult.ok || !resolveResult.data?.runMethodLock) {
    throw registryFailure('STRICT_RESOLVE_REJECTED', resolveResult.diagnostics);
  }

  const runLock = resolveResult.data.runMethodLock;
  const reverified = registry.verifyProvider({
    host: input.host,
    runLock: { ...runLock, inventoryEntry },
  });
  if (reverified.status !== 'verified') {
    throw registryFailure('RUN_LOCK_REVERIFY_REJECTED', reverified.diagnostics);
  }

  return {
    status: 'VERIFIED',
    code: 'PREFLIGHT_VERIFIED',
    service: input.service,
    ref: serviceDef.id,
    runLock: {
      queryDigest: runLock.queryDigest,
      indexDigest: runLock.indexDigest,
      bindingDigest: runLock.bindingDigest,
      serviceImplementationId: runLock.serviceImplementationId,
      provider: { pluginId: runLock.provider.pluginId, host: runLock.provider.host, skillPath: runLock.provider.skillPath },
      sideEffectSummary: runLock.sideEffectSummary,
      filesystemReverified: true,
    },
    diagnostics: [],
  };
}

function validateExactBinding(binding, input) {
  if (!binding) throw new ServiceError('NOT_ENABLED', [DIAGNOSTICS.NOT_ENABLED]);
  if (binding.documentKind !== 'v2-binding' || binding.schemaVersion !== 2 || !Array.isArray(binding.bindings)) {
    throw new ServiceError('BINDING_INVALID', [DIAGNOSTICS.BINDING_INVALID]);
  }
  if (binding.bindings.length !== 1 || (binding.serviceBindings?.length ?? 0) !== 0) {
    throw new ServiceError('PARTIAL_BINDING_REJECTED', [DIAGNOSTICS.PARTIAL_BINDING_REJECTED]);
  }
  const selected = binding.bindings[0];
  const expected = {
    familyId: 'e2e-test', implementationId: 'io.github.mzdbxqh.e2e-test', version: '0.2.0-alpha.2', pluginId: 'e2e-test',
  };
  // R4: Use snapshot-read API identity for validation (not hardcoded constants)
  if (selected.familyId !== expected.familyId || selected.apiIdentity?.apiId !== SNAPSHOT_API_ID || selected.apiIdentity?.apiMajor !== SNAPSHOT_API_MAJOR ||
      selected.apiIdentity?.apiRevisionDigest !== SNAPSHOT_API_REVISION || selected.implementationIdentity?.familyImplementationId !== expected.implementationId ||
      selected.implementationIdentity?.version !== expected.version || selected.providerSelector?.scope !== 'plugin' ||
      selected.providerSelector?.pluginId !== expected.pluginId) {
    throw new ServiceError('BINDING_IDENTITY_MISMATCH', [DIAGNOSTICS.BINDING_IDENTITY_MISMATCH]);
  }
  if (selected.providerSelector.host !== input.host) throw new ServiceError('HOST_MISMATCH', [DIAGNOSTICS.HOST_MISMATCH]);
  let selectedRoot;
  try { selectedRoot = realpathSync(selected.providerSelector.canonicalRoot); } catch { throw new ServiceError('PROVIDER_ROOT_INVALID', [DIAGNOSTICS.PROVIDER_ROOT_INVALID]); }
  if (selectedRoot !== pluginRoot) throw new ServiceError('PROVIDER_ROOT_MISMATCH', [DIAGNOSTICS.PROVIDER_ROOT_MISMATCH]);
  if (selected.providerSelector.packageDigest !== input.installation.packageDigest ||
      selected.providerSelector.provenance !== input.installation.provenance) {
    throw new ServiceError('PACKAGE_IDENTITY_MISMATCH', [DIAGNOSTICS.PACKAGE_IDENTITY_MISMATCH]);
  }
  const treeDigest = descriptorText.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  const attestation = descriptorText.match(/^\s*deterministicAttestation:\s*(sha256:[a-f0-9]{64}|null)\s*$/m)?.[1];
  if (selected.providerSelector.bundleDigest !== treeDigest) throw new ServiceError('BUNDLE_DIGEST_MISMATCH', [DIAGNOSTICS.BUNDLE_DIGEST_MISMATCH]);
  if (selected.conformanceEvidence?.deterministicAttestation !== attestation) {
    throw new ServiceError('ATTESTATION_MISMATCH', [DIAGNOSTICS.ATTESTATION_MISMATCH]);
  }
  if (!selected.authorization?.granted) throw new ServiceError('AUTHORIZATION_DENIED', [DIAGNOSTICS.AUTHORIZATION_DENIED]);
}

async function tryLoadRegistry() {
  try {
    const api = await import('agent-method-registry');
    const entry = fileURLToPath(import.meta.resolve('agent-method-registry'));
    const version = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version ?? null;
    return { api, version, error: null };
  } catch {
    return { api: null, version: null, error: null };
  }
}

function isRegistryApiCompatible(api, version) {
  return /^0\.2\./.test(version || '') &&
    REQUIRED_REGISTRY_API.every(name => typeof api?.[name] === 'function');
}

async function tryLoadArtifactGraph() {
  try {
    return { api: await import('artifact-graph'), error: null };
  } catch {
    return { api: null, error: null };
  }
}

function resolveArtifactContractIdentity() {
  const candidates = [];
  const explicit = process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND;
  if (explicit && isAbsolute(explicit)) candidates.push(explicit);
  try {
    const entry = require.resolve('artifact-graph');
    candidates.push(join(dirname(entry), 'cli.js'));
  } catch { /* optional peer may be absent */ }

  for (const command of candidates) {
    if (!existsSync(command)) continue;
    try {
      const stdout = execFileSync(process.execPath, [
        command,
        'contract',
        'explain',
        '--contract',
        CONTRACT_ID,
        '--format',
        'json',
      ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      const parsed = JSON.parse(stdout);
      const revisionDigest = parsed?.data?.identity?.revisionDigest;
      if (parsed?.ok === true && /^sha256:[a-f0-9]{64}$/.test(revisionDigest || '')) {
        return { revisionDigest, source: 'artifact-graph-cli' };
      }
    } catch { /* try the next installed candidate */ }
  }
  return { revisionDigest: null, source: null };
}

function parseImplementation(text) {
  const scalar = name => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const nested = (section, name) => text.match(new RegExp(`^${section}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, 'm'))?.[1]
    ?.match(new RegExp(`^[ \\t]+${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const rootsBlock = text.match(/^bundle:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1]
    ?.match(/^[ \t]+roots:\s*\n((?:[ \t]+- .*\n?)*)/m)?.[1] ?? '';
  const roots = rootsBlock.split('\n').map(line => line.match(/^[ \t]+-\s+(.+)$/)?.[1]?.trim()).filter(Boolean);
  const services = {};
  for (const match of text.matchAll(/^  (artifact\.e2e-test\.[a-z]+):\s*\n    serviceImplementationId:\s*(.+)\n    skill:\s*(.+)$/gm)) {
    services[match[1]] = { serviceImplementationId: match[2].trim(), skill: match[3].trim() };
  }
  return {
    documentKind: scalar('documentKind'), schemaVersion: Number(scalar('schemaVersion')),
    familyImplementationId: scalar('familyImplementationId'), version: scalar('version'), pluginId: scalar('pluginId'),
    implements: { apiId: nested('implements', 'apiId'), apiMajor: Number(nested('implements', 'apiMajor')), apiRevisionDigest: nested('implements', 'apiRevisionDigest') },
    services,
    bundle: { roots, treeDigest: nested('bundle', 'treeDigest') },
    hostSupport: { codex: { available: true }, 'claude-code': { available: true } },
    lifecycle: {
      ownership: nested('lifecycle', 'ownership') || 'independent',
      maturity: nested('lifecycle', 'maturity') || 'experimental',
      channel: nested('lifecycle', 'channel') || 'stable',
    },
    conformance: {
      deterministicAttestation: nested('conformance', 'deterministicAttestation') === 'null' ? null : nested('conformance', 'deterministicAttestation'),
      behaviorQualification: null,
    },
  };
}

function isDigest(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }

function registryFailure(code, diagnostics = []) {
  return new ServiceError(code, diagnostics.map(item => ({
    code: item.code || code, severity: item.severity || 'error',
  })));
}

function emitSuccess(value) {
  process.stdout.write(`${JSON.stringify(value, null, jsonMode ? 2 : 0)}\n`);
  process.exit(0);
}

function emitFailure(error, service = request?.service ?? null) {
  // R5: Structured output only — no raw Error.message, no path sanitization needed
  const output = {
    status: 'BLOCKED',
    code: error.code ?? 'PREFLIGHT_FAILED',
    service,
    diagnostics: error.diagnostics ?? [{ code: error.code ?? 'PREFLIGHT_FAILED', severity: 'error' }],
  };
  process.stdout.write(`${JSON.stringify(output, null, jsonMode ? 2 : 0)}\n`);
  process.exit(1);
}
