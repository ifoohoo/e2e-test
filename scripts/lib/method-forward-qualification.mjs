import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { stableDigest } from './digest.mjs';

export function signMethodForwardQualification(unsigned) {
  return { ...unsigned, digest: stableDigest(unsigned) };
}

export function validateMethodForwardQualification(pluginRoot, evidence) {
  const diagnostics = [];
  let schemaValid = false;
  try {
    const schema = JSON.parse(readFileSync(join(pluginRoot, 'schemas', 'method-forward-qualification.json'), 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    schemaValid = Boolean(ajv.compile(schema)(evidence));
  } catch {
    diagnostics.push('METHOD_FORWARD_SCHEMA_UNAVAILABLE');
  }
  const { digest, ...unsigned } = evidence || {};
  const digestValid = typeof digest === 'string' && stableDigest(unsigned) === digest;
  if (!digestValid) diagnostics.push('METHOD_FORWARD_DIGEST_INVALID');

  const packages = evidence?.packages || [];
  const packageIds = new Set(packages.map(item => item.packageId));
  const domains = new Set(packages.map(item => item.domain));
  const packagesValid = packages.length >= 3 && packageIds.size === packages.length &&
    domains.size === packages.length && packages.every(item => item.containsExpectedArtifacts === false);
  if (!packagesValid) diagnostics.push('METHOD_FORWARD_PACKAGES_INVALID');

  const pending = evidence?.qualificationStatus === 'FORWARD_TRIALS_PENDING_CODEX';
  const pendingValid = !pending || (
    evidence.pendingMarkers?.includes('FORWARD_TRIALS_PENDING_CODEX') &&
    evidence.hosts?.codex?.status === 'PENDING' && evidence.hosts?.claude?.status === 'PENDING'
  );
  if (!pendingValid) diagnostics.push('METHOD_FORWARD_PENDING_INVALID');

  const qualified = evidence?.qualificationStatus === 'QUALIFIED';
  const qualifiedValid = !qualified || (
    ['codex', 'claude'].every(host => {
      const value = evidence.hosts?.[host];
      return value?.status === 'QUALIFIED' && value.trials?.length === packages.length &&
        new Set(value.trials.map(item => item.packageId)).size === packages.length &&
        value.trials.every(item => item.authorChainCompleted && item.zeroUnauthorizedWrites &&
          !item.absolutePathDetected && item.stageChainDigest && item.rubricDigest);
    }) && evidence.rubricSummary?.partialCount === 0 && evidence.rubricSummary?.failCount === 0
  );
  if (!qualifiedValid) diagnostics.push('METHOD_FORWARD_QUALIFIED_INVALID');

  const independent = evidence?.independentFromOperational === true;
  if (!independent) diagnostics.push('METHOD_FORWARD_NOT_INDEPENDENT');
  const valid = schemaValid && digestValid && packagesValid && pendingValid && qualifiedValid && independent;
  return {
    valid,
    status: valid ? evidence.qualificationStatus : 'BLOCKED',
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

export function buildPendingMethodForwardQualification({ packages, evidence }) {
  return signMethodForwardQualification({
    schemaVersion: 1,
    qualificationKind: 'methodForwardQualification',
    qualificationStatus: 'FORWARD_TRIALS_PENDING_CODEX',
    independentFromOperational: true,
    pendingMarkers: ['FORWARD_TRIALS_PENDING_CODEX'],
    packages,
    hosts: {
      codex: { status: 'PENDING', trials: [] },
      claude: { status: 'PENDING', trials: [] },
    },
    rubricSummary: { passCount: 0, partialCount: 0, failCount: 0 },
    oracleContract: {
      runnerContract: '每个真实宿主从隔离原始包自行运行完整八阶段 author 链，只允许默认预览。',
      evidenceContract: '只接受阶段结果摘要、预览清单、零未授权写入证明及独立 rubric；不得读取期望答案。',
      rubricSchema: 'schemas/forward-trial-rubric.json',
    },
    evidence,
  });
}
