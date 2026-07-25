#!/usr/bin/env node

/**
 * gate-status.mjs
 *
 * 输出 E2E 测试技能族的 Gate B 状态（机器可读 JSON）。
 * 所有验证从共享状态内核派生，不得从目录存在或硬编码 implemented 推导。
 *
 * 用法:
 *   node scripts/gate-status.mjs [--json]
 *   node scripts/gate-status.mjs --service <help|default|author|review|repair> [--json]
 *
 * --service help   : 退出 0，输出完整 Gate 状态
 * --service 其他   : 退出非零（如未绑定），输出 fail-closed 结构化状态
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTruthKernel } from './lib/truthfulness-kernel.mjs';
import { loadFindingManifest, stableBlocked } from './lib/finding-manifest.mjs';
import { diagnoseExternalRoots } from './lib/precondition-diagnostics.mjs';

const pluginRoot = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const serviceIdx = args.indexOf('--service');
const service = serviceIdx !== -1 ? args[serviceIdx + 1] : null;

// ─── 读取 package.json ───
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// ─── 共享状态内核验证 ───
const kernel = createTruthKernel(pluginRoot);
const kernelStatus = await kernel.verify();
const findingCapability = loadFindingManifest(pluginRoot);
// 三个外部 root 前置条件显式诊断（轻量路径检查，不触发真实 conformance run），
// 供门禁区分"通过 / 诚实阻断（外部前置缺失）/ 失败"。
let installedRegistryRootForDiag = null;
try {
  installedRegistryRootForDiag = join(dirname(fileURLToPath(import.meta.resolve('agent-method-registry'))), '..');
} catch {
  installedRegistryRootForDiag = null;
}
const preconditions = diagnoseExternalRoots({
  env: process.env,
  resolvedPaths: { 'agent-method-registry': installedRegistryRootForDiag },
});
const implementationText = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
const lifecycleMaturity = implementationText.match(/^\s*maturity:\s*(\S+)\s*$/m)?.[1] || 'unknown';
const stablePolicyViolation = lifecycleMaturity === 'stable' && stableBlocked(findingCapability.manifest);

// ─── 检查结构文件存在性（skills、schemas、references、fixtures）───
const allSkillsPresent = ['e2e-test-help', 'e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'].every(s => {
  try { statSync(join(pluginRoot, 'skills', s, 'SKILL.md')); return true; } catch { return false; }
});

const requiredSchemas = ['inspection.json', 'candidate-assessment.json', 'matrix.json', 'proof-binding.json', 'stage-result.json', 'review-result.json', 'artifact-package-manifest.json', 'finding-capability-manifest.json', 'author-raw-input.json', 'preview-manifest.json', 'forward-trial-rubric.json', 'forward-trial-rubric-review.json', 'forward-reviewer-packet.json', 'method-forward-host-receipt.json', 'method-forward-trial-result.json', 'method-forward-qualification.json'];
const allSchemasPresent = requiredSchemas.every(s => {
  try { statSync(join(pluginRoot, 'schemas', s)); return true; } catch { return false; }
});

const requiredReferences = ['methodology.md', 'candidate-assessment.md', 'matrix-model.md', 'findings-catalog.md', 'proof-reconciliation.md', 'forward-trial-rubric.md'];
const allReferencesPresent = requiredReferences.every(r => {
  try { statSync(join(pluginRoot, 'references', r)); return true; } catch { return false; }
});

let fixtureStatus = 'missing';
try { statSync(join(pluginRoot, 'fixtures')); fixtureStatus = 'present'; } catch {}

// ─── 确定服务状态（从内核派生，非硬编码）───
function deriveServiceStatus(serviceName) {
  if (serviceName === 'help') {
    return { status: 'available', behavior: 'read-only-diagnostic' };
  }
  if (kernelStatus.familyEnablement.status !== 'enabled') {
    return { status: 'fail-closed', reason: 'NOT_ENABLED', message: 'provider 已安装但未启用。请通过项目显式 binding 启用。使用 e2e-test-help 查看状态。' };
  }
  return { status: 'available', behavior: 'registry-bound' };
}

// Gate passed: 所有基础结构存在 + conformance 通过 + behavior qualification 合格
const gatePassed = allSkillsPresent && allSchemasPresent && allReferencesPresent
  && kernelStatus.providerInstallation.status === 'consistent'
  && fixtureStatus === 'present'
  && !stablePolicyViolation
  && kernelStatus.conformance.status === 'pass'
  && kernelStatus.qualification.status === 'qualified';

// ─── 构造服务响应 ───
const SERVICE_KEY_MAP = {
  help: 'e2e-test-help',
  default: 'e2e-test',
  author: 'e2e-test-author',
  review: 'e2e-test-review',
  repair: 'e2e-test-repair',
};
const serviceResponses = {};
for (const [shortName, fullKey] of Object.entries(SERVICE_KEY_MAP)) {
  serviceResponses[shortName] = { key: fullKey, ...deriveServiceStatus(shortName) };
}

// ─── --service 模式 ───
if (service) {
  if (!serviceResponses[service]) {
    console.error(`Unknown service: ${service}. Valid: help, default, author, review, repair`);
    process.exit(1);
  }

  const response = { service, ...serviceResponses[service] };
  if (jsonMode) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log(`Service: ${response.service || service}`);
    console.log(`Status: ${response.status}`);
    if (response.reason) console.log(`Reason: ${response.reason}`);
    if (response.message) console.log(`Message: ${response.message}`);
  }

  if (service !== 'help') {
    process.exit(response.status === 'available' ? 0 : 1);
  }
  process.exit(0);
}

// ─── 默认模式：输出完整 Gate B 状态 ───
const status = {
  version: pkg.version,
  gate: 'B',
  gatePassed,
  implementation: {
    descriptor: kernelStatus.providerInstallation.status === 'consistent' ? 'present' : 'inconsistent',
    path: 'family/implementation.yaml',
    id: kernelStatus.implementation?.id ?? 'unknown',
    version: kernelStatus.implementation?.version ?? pkg.version,
    bundleObserved: kernelStatus.providerInstallation.bundleObserved,
    bundleMatch: kernelStatus.providerInstallation.bundleMatch,
  },
  skills: Object.fromEntries(
    ['e2e-test-help', 'e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'].map(s => {
      let st = 'missing';
      try { statSync(join(pluginRoot, 'skills', s, 'SKILL.md')); st = 'present'; } catch {}
      return [s, st];
    })
  ),
  adapters: Object.fromEntries(
    ['codex', 'claude'].map(h => {
      let st = 'missing';
      try { statSync(join(pluginRoot, 'adapters', h, 'skills', 'e2e-test-help', 'SKILL.md')); st = 'present'; } catch {}
      return [h, st];
    })
  ),
  schemas: Object.fromEntries(
    requiredSchemas.map(s => {
      let st = 'missing';
      try { statSync(join(pluginRoot, 'schemas', s)); st = 'present'; } catch {}
      return [s, st];
    })
  ),
  references: Object.fromEntries(
    requiredReferences.map(r => {
      let st = 'missing';
      try { statSync(join(pluginRoot, 'references', r)); st = 'present'; } catch {}
      return [r, st];
    })
  ),
  fixtures: fixtureStatus,
  services: Object.fromEntries(
    Object.entries(serviceResponses).map(([k, v]) => [v.key, v])
  ),
  defaultEnabled: kernelStatus.familyEnablement.status === 'enabled',
  registry: {
    bound: kernelStatus.familyEnablement.status === 'enabled',
    binding: null,
  },
  contracts: {
    artifact: {
      id: kernelStatus.contracts.artifact.id,
      revisionDigest: kernelStatus.contracts.artifact.revisionDigest,
      status: kernelStatus.contracts.artifact.revisionDigest ? 'qualified-snapshot' : 'unavailable',
    },
    familyApi: kernelStatus.contracts.familyApi
      ? {
          id: kernelStatus.contracts.familyApi.id,
          revisionDigest: kernelStatus.contracts.familyApi.revisionDigest,
          status: 'registered',
        }
      : { id: null, revisionDigest: null, status: 'unavailable' },
  },
  conformance: {
    deterministic: kernelStatus.conformance.status,
    attestation: kernelStatus.conformance.attestation,
    behaviorQualification: kernelStatus.qualification.status,
    operationalQualification: kernelStatus.qualifications.operational.status,
    methodForwardQualification: kernelStatus.qualifications.methodForward.status,
    methodForwardPendingMarkers: kernelStatus.qualifications.methodForward.pendingMarkers,
    releaseArtifactCertification: kernelStatus.qualifications.releaseArtifact,
    // 不输出已解析绝对路径（输出路径安全合同：help/gate 输出不得含本机路径）；
    // 诊断以 root × envVar × 解析来源 × 状态 表达，路径细节见 conformance-runner 输出。
    preconditions: preconditions.roots.map(({ root, envVar, resolutionSource, status }) => ({ root, envVar, resolutionSource, status })),
    preconditionBlocked: kernelStatus.conformance.status !== 'pass' && !preconditions.allPresent,
  },
  findingCapabilities: {
    digest: findingCapability.digest,
    implemented: [...findingCapability.rules.values()].filter(item => item.status !== 'planned').map(item => item.rule),
    planned: [...findingCapability.rules.values()].filter(item => item.status === 'planned').map(item => item.rule),
    stableBlocked: stableBlocked(findingCapability.manifest),
    lifecycleMaturity,
    policyViolation: stablePolicyViolation,
  },
};

if (jsonMode) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`E2E Test Skill Family v${status.version} (Gate ${status.gate})`);
  console.log(`Gate B Passed: ${status.gatePassed}`);
  console.log();
  console.log(`Artifact Contract: ${status.contracts.artifact.id}`);
  console.log(`  revision: ${status.contracts.artifact.revisionDigest}`);
  console.log(`Family API: ${status.contracts.familyApi.id}`);
  console.log(`  revision: ${status.contracts.familyApi.revisionDigest}`);
  console.log();
  console.log('Skills:');
  for (const [name, s] of Object.entries(status.skills)) {
    console.log(`  ${name}: ${s}`);
  }
  console.log();
  console.log('Services:');
  for (const [name, svc] of Object.entries(status.services)) {
    console.log(`  ${name}: ${svc.status}${svc.behavior ? ` (${svc.behavior})` : ''}`);
  }
  console.log();
  console.log(`Default Enabled: ${status.defaultEnabled}`);
  console.log(`Registry Bound: ${status.registry.bound}`);
  console.log(`Conformance: ${status.conformance.deterministic}${status.conformance.preconditionBlocked ? ' (BLOCKED_HONEST: external root preconditions missing)' : ''}`);
  for (const p of status.conformance.preconditions) {
    console.log(`  ${p.status === 'present' ? '✓' : '⊘'} ${p.root}: ${p.status} [${p.resolutionSource}]`);
  }
  console.log(`Behavior Qualification: ${status.conformance.behaviorQualification}`);
  console.log(`Method Forward Qualification: ${status.conformance.methodForwardQualification}`);
  console.log(`Release Artifact Certification: ${status.conformance.releaseArtifactCertification}`);
}
