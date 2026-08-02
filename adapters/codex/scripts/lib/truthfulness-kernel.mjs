#!/usr/bin/env node

/**
 * E2E 技能族真实性内核。
 *
 * gate-status、service-runner help 与发布验证器只能从本内核取得可信状态。
 * 内核会复验当前文件系统 bundle、确定性符合性证明和行为资格主体；任何
 * 缺失、漂移或解析失败都关闭为“不可信”，且只返回稳定诊断码。
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQualificationSubject,
  containsAbsolutePath,
  createValidators,
  verifyEmbeddedDigest,
} from './behavior-qualification.mjs';

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const ROOT_KEYS = ['root', 'codex', 'claude'];
const REQUIRED_REGISTRY_API = [
  'buildEffectiveIndex',
  'queryEffectiveIndex',
  'resolveEntry',
  'verifyProvider',
];

export function createTruthKernel(pluginRoot, options = {}) {
  const root = resolve(pluginRoot);

  async function verify() {
    const diagnostics = new Set();
    const rootKind = detectRootKind(root);
    const host = rootKind === 'claude' ? 'claude-code' : 'codex';

    const pkg = readJson(join(root, 'package.json'), diagnostics, 'PACKAGE_UNAVAILABLE');
    const apiSnapshot = readJson(join(root, 'authority-api', 'api.json'), diagnostics, 'API_SNAPSHOT_UNAVAILABLE');
    const descriptor = readDescriptor(join(root, 'family', 'implementation.yaml'), diagnostics);

    const descriptorApiConsistent = Boolean(
      apiSnapshot?.api &&
      descriptor &&
      descriptor.apiId === apiSnapshot.api.id &&
      descriptor.apiMajor === apiSnapshot.api.major &&
      descriptor.apiRevisionDigest === apiSnapshot.api.revisionDigest
    );
    if (!descriptorApiConsistent) diagnostics.add('API_IDENTITY_MISMATCH');

    const packageIdentityConsistent = Boolean(
      pkg && descriptor &&
      pkg.name === descriptor.pluginId &&
      pkg.version === descriptor.version
    );
    if (!packageIdentityConsistent) diagnostics.add('PACKAGE_IDENTITY_MISMATCH');

    let registryApi = null;
    let registryInstalled = false;
    let registryVersion = null;
    try {
      registryApi = await import('agent-method-registry');
      registryInstalled = true;
      registryVersion = readInstalledPackageVersion('agent-method-registry');
      if (!isRegistryApiCompatible(registryApi, registryVersion)) {
        registryApi = null;
        diagnostics.add('REGISTRY_API_INCOMPATIBLE');
      }
    } catch {
      diagnostics.add('REGISTRY_RUNTIME_UNAVAILABLE');
    }

    let artifactGraphAvailable = false;
    try {
      await import('artifact-graph');
      artifactGraphAvailable = true;
    } catch {
      diagnostics.add('ARTIFACT_GRAPH_RUNTIME_UNAVAILABLE');
    }

    const bundle = observeBundle({ root, host, descriptor, registryApi, diagnostics });
    const conformance = verifyConformance({ root, descriptor, bundle, diagnostics });
    const qualification = verifyQualification({
      root,
      rootKind,
      descriptor,
      apiSnapshot,
      bundle,
      conformance,
      diagnostics,
    });
    const methodForwardQualification = await verifyMethodForwardQualification({
      root, descriptor, apiSnapshot, bundle, diagnostics,
    });

    const providerInstallationConsistent = Boolean(
      descriptorApiConsistent && packageIdentityConsistent && bundle.match
    );
    const registryBound = options.bindingVerified === true;

    return {
      rootKind,
      implementation: descriptor
        ? {
            id: descriptor.familyImplementationId,
            version: descriptor.version,
            pluginId: descriptor.pluginId,
          }
        : null,
      providerInstallation: {
        status: providerInstallationConsistent ? 'consistent' : 'inconsistent',
        descriptorApiConsistent,
        packageIdentityConsistent,
        bundleObserved: Boolean(bundle.observedDigest),
        bundleMatch: bundle.match,
      },
      conformance,
      qualification,
      qualifications: {
        operational: qualification,
        methodForward: methodForwardQualification,
        releaseArtifact: null,
      },
      familyEnablement: { status: registryBound ? 'enabled' : 'not-enabled' },
      contracts: {
        artifact: {
          id: 'artifact.e2e-test@1',
          revisionDigest: qualification.contractRevisionDigest,
        },
        familyApi: apiSnapshot?.api
          ? {
              id: `${apiSnapshot.api.id}@${apiSnapshot.api.major}`,
              revisionDigest: apiSnapshot.api.revisionDigest,
            }
          : null,
      },
      runtime: {
        registryInstalled,
        registryVersion,
        registry: Boolean(registryApi),
        artifactGraph: artifactGraphAvailable,
      },
      diagnostics: [...diagnostics].sort().map(code => ({ code, severity: 'error' })),
    };
  }

  return { verify };
}

async function verifyMethodForwardQualification({ root, descriptor, apiSnapshot, bundle, diagnostics }) {
  const path = join(root, 'conformance', 'method-forward-qualification.json');
  if (!existsSync(path)) {
    return { status: 'NOT_STARTED', evidenceValid: false, pendingMarkers: [] };
  }
  const evidence = readJson(path, diagnostics, 'METHOD_FORWARD_EVIDENCE_UNAVAILABLE');
  if (!evidence) return { status: 'BLOCKED', evidenceValid: false, pendingMarkers: [] };
  let validateMethodForwardQualification;
  try {
    ({ validateMethodForwardQualification } = await import('./method-forward-qualification.mjs'));
  } catch {
    diagnostics.add('METHOD_FORWARD_VALIDATOR_UNAVAILABLE');
    return {
      status: 'BLOCKED',
      evidenceValid: false,
      pendingMarkers: evidence.pendingMarkers || [],
      hosts: Object.fromEntries(
        Object.entries(evidence.hosts || {}).map(([key, value]) => [key, value.status]),
      ),
      digest: null,
    };
  }
  const validation = validateMethodForwardQualification(root, evidence);
  const identityValid = Boolean(
    descriptor && apiSnapshot?.api && bundle.match &&
    evidence.evidence?.familyApiRevision === apiSnapshot.api.revisionDigest &&
    evidence.evidence?.bundleDigest === descriptor.treeDigest &&
    evidence.evidence?.deterministicAttestation === descriptor.deterministicAttestation
  );
  if (!identityValid) diagnostics.add('METHOD_FORWARD_IDENTITY_MISMATCH');
  if (!validation.valid) diagnostics.add('METHOD_FORWARD_EVIDENCE_INVALID');
  return {
    status: validation.valid && identityValid ? evidence.qualificationStatus : 'BLOCKED',
    evidenceValid: validation.valid && identityValid,
    pendingMarkers: evidence.pendingMarkers || [],
    hosts: Object.fromEntries(Object.entries(evidence.hosts || {}).map(([key, value]) => [key, value.status])),
    digest: validation.valid ? evidence.digest : null,
  };
}

function readInstalledPackageVersion(packageName) {
  try {
    const entry = fileURLToPath(import.meta.resolve(packageName));
    return JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function isRegistryApiCompatible(api, version) {
  return /^0\.2\./.test(version || '') &&
    REQUIRED_REGISTRY_API.every(name => typeof api?.[name] === 'function');
}

function detectRootKind(root) {
  const name = basename(root);
  return basename(dirname(root)) === 'adapters' && ['codex', 'claude'].includes(name)
    ? name
    : 'root';
}

function readJson(path, diagnostics, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    diagnostics.add(code);
    return null;
  }
}

function readDescriptor(path, diagnostics) {
  try {
    const text = readFileSync(path, 'utf8');
    const scalar = name => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    const nested = (section, name) => {
      const block = text.match(new RegExp(`^${section}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, 'm'))?.[1];
      return block?.match(new RegExp(`^[ \\t]+${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    };
    const bundleBlock = text.match(/^bundle:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
    const rootsBlock = bundleBlock.match(/^[ \t]+roots:\s*\n((?:[ \t]+- .*\n?)*)/m)?.[1] ?? '';
    const roots = rootsBlock
      .split('\n')
      .map(line => line.match(/^[ \t]+-\s+(.+)$/)?.[1]?.trim())
      .filter(Boolean);
    const result = {
      text,
      familyImplementationId: scalar('familyImplementationId'),
      version: scalar('version'),
      pluginId: scalar('pluginId'),
      apiId: nested('implements', 'apiId'),
      apiMajor: Number(nested('implements', 'apiMajor')),
      apiRevisionDigest: nested('implements', 'apiRevisionDigest'),
      roots,
      treeDigest: nested('bundle', 'treeDigest'),
      deterministicAttestation: nested('conformance', 'deterministicAttestation'),
      behaviorQualification: nested('conformance', 'behaviorQualification'),
    };
    if (!result.familyImplementationId || !result.version || !result.pluginId ||
        !result.apiId || !Number.isInteger(result.apiMajor) || !result.apiRevisionDigest ||
        result.roots.length === 0 || !result.treeDigest) {
      diagnostics.add('DESCRIPTOR_INVALID');
      return null;
    }
    return result;
  } catch {
    diagnostics.add('DESCRIPTOR_UNAVAILABLE');
    return null;
  }
}

function observeBundle({ root, host, descriptor, registryApi, diagnostics }) {
  if (!descriptor || !registryApi) {
    diagnostics.add('BUNDLE_NOT_OBSERVED');
    return { status: 'unavailable', observedDigest: null, match: false };
  }
  try {
    const inventoryEntry = {
      pluginId: descriptor.pluginId,
      canonicalRoot: root,
      version: descriptor.version,
      packageDigest: ZERO_DIGEST,
      provenance: 'truthfulness-kernel',
      host,
    };
    const result = registryApi.verifyProvider({
      host,
      v2: {
        implementation: {
          pluginId: descriptor.pluginId,
          version: descriptor.version,
          bundle: { roots: descriptor.roots, treeDigest: descriptor.treeDigest },
        },
        inventoryEntry,
        providerInstance: {
          scope: 'plugin',
          pluginId: descriptor.pluginId,
          host,
          canonicalRoot: root,
          skillPath: 'skills/e2e-test-help',
          packageDigest: ZERO_DIGEST,
          bundleDigest: descriptor.treeDigest,
          provenance: 'truthfulness-kernel',
        },
        inventorySnapshot: { digest: ZERO_DIGEST, freshness: 'fresh' },
      },
    });
    const observedDigest = result?.observed?.bundleDigest ?? null;
    const match = result?.status === 'verified' && observedDigest === descriptor.treeDigest;
    if (!observedDigest) diagnostics.add('BUNDLE_NOT_OBSERVED');
    else if (!match) diagnostics.add('BUNDLE_DIGEST_MISMATCH');
    return { status: result?.status ?? 'unavailable', observedDigest, match };
  } catch {
    diagnostics.add('BUNDLE_OBSERVATION_FAILED');
    return { status: 'unavailable', observedDigest: null, match: false };
  }
}

function verifyConformance({ root, descriptor, bundle, diagnostics }) {
  const evidence = readJson(
    join(root, 'conformance', 'last-run.json'),
    diagnostics,
    'CONFORMANCE_EVIDENCE_UNAVAILABLE',
  );
  const evidenceMatches = Boolean(
    evidence && descriptor && bundle.match &&
    evidence.status === 'PASS' &&
    evidence.bundleDigest === descriptor.treeDigest &&
    evidence.attestation?.digest === descriptor.deterministicAttestation
  );
  if (!evidenceMatches) diagnostics.add('CONFORMANCE_EVIDENCE_STALE');
  return {
    status: evidenceMatches ? 'pass' : 'fail',
    attestation: evidenceMatches ? descriptor.deterministicAttestation : null,
  };
}

function verifyQualification({ root, rootKind, descriptor, apiSnapshot, bundle, conformance, diagnostics }) {
  const result = descriptor?.behaviorQualification === 'conformance/behavior-qualification.json'
    ? readJson(
        join(root, 'conformance', 'behavior-qualification.json'),
        diagnostics,
        'QUALIFICATION_EVIDENCE_UNAVAILABLE',
      )
    : null;
  if (!result) {
    diagnostics.add('QUALIFICATION_EVIDENCE_STALE');
    return emptyQualification();
  }

  let schemaValid = false;
  try {
    schemaValid = Boolean(createValidators(join(root, 'schemas')).result(result));
  } catch {
    diagnostics.add('QUALIFICATION_SCHEMA_UNAVAILABLE');
  }

  const subjects = result.evidence?.qualificationSubjects ?? {};
  const subjectRoots = rootKind === 'root'
    ? {
        root,
        codex: join(root, 'adapters', 'codex'),
        claude: join(root, 'adapters', 'claude'),
      }
    : { [rootKind]: root };
  let subjectsValid = true;
  for (const [key, subjectRoot] of Object.entries(subjectRoots)) {
    if (!existsSync(join(subjectRoot, 'package.json'))) {
      subjectsValid = false;
      diagnostics.add(`QUALIFICATION_SUBJECT_${key.toUpperCase()}_UNAVAILABLE`);
      continue;
    }
    try {
      const observed = buildQualificationSubject(subjectRoot);
      if (subjects[key]?.algorithm !== observed.algorithm || subjects[key]?.digest !== observed.digest) {
        subjectsValid = false;
        diagnostics.add(`QUALIFICATION_SUBJECT_${key.toUpperCase()}_MISMATCH`);
      }
    } catch {
      subjectsValid = false;
      diagnostics.add(`QUALIFICATION_SUBJECT_${key.toUpperCase()}_INVALID`);
    }
  }

  const identities = result.evidence?.scenarioIdentities ?? {};
  const identitiesValid = ['codex', 'claude'].every(key =>
    identities[key]?.familyApiRevision === apiSnapshot?.api?.revisionDigest &&
    identities[key]?.implementationId === descriptor?.familyImplementationId &&
    identities[key]?.implementationVersion === descriptor?.version &&
    identities[key]?.qualificationSubjectDigest === subjects[key]?.digest
  );
  if (!identitiesValid) diagnostics.add('QUALIFICATION_IDENTITY_MISMATCH');

  const localIdentity = rootKind === 'root'
    ? {
        bundleDigest: result.evidence?.bundleDigest,
        deterministicAttestation: result.evidence?.deterministicAttestation,
      }
    : identities[rootKind];
  const localProofValid = Boolean(
    descriptor && bundle.match && conformance.status === 'pass' &&
    localIdentity?.bundleDigest === descriptor.treeDigest &&
    localIdentity?.deterministicAttestation === descriptor.deterministicAttestation
  );
  if (!localProofValid) diagnostics.add('QUALIFICATION_LOCAL_PROOF_MISMATCH');

  const hostsQualified =
    result.hosts?.codex?.status === 'QUALIFIED' &&
    result.hosts?.claude?.status === 'QUALIFIED';
  const valid = Boolean(
    schemaValid && verifyEmbeddedDigest(result) &&
    result.qualificationStatus === 'QUALIFIED' &&
    result.trials?.length === 26 &&
    hostsQualified && identitiesValid && subjectsValid && localProofValid &&
    !containsAbsolutePath(result) &&
    result.evidence?.familyApiRevision === apiSnapshot?.api?.revisionDigest
  );
  if (!valid) diagnostics.add('QUALIFICATION_EVIDENCE_STALE');

  return {
    status: valid ? 'qualified' : 'not-qualified',
    evidenceValid: valid,
    hosts: Object.fromEntries(
      Object.entries(result.hosts ?? {}).map(([key, value]) => [key, value.status]),
    ),
    contractRevisionDigest: valid ? result.evidence?.contractRevision ?? null : null,
    subjectsVerified: subjectsValid,
  };
}

function emptyQualification() {
  return {
    status: 'not-qualified',
    evidenceValid: false,
    hosts: {},
    contractRevisionDigest: null,
    subjectsVerified: false,
  };
}
