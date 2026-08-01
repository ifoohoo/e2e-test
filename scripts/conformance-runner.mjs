#!/usr/bin/env node

/**
 * conformance-runner.mjs
 *
 * Gate B fail-closed deterministic conformance runner。
 * 使用 AJV 真实 schema 验证、artifact-graph CLI contract 验证、
 * artifact-chain-assistant family-compile、Registry v2 public API 全链
 * (inventory→binding→projection→query→resolve(host)→run-lock→reverify)。
 *
 * 用法:
 *   node scripts/conformance-runner.mjs [--json]
 *
 * 环境变量（必须设置，否则 fail closed）:
 *   E2E_TEST_ARTIFACT_GRAPH_ROOT  — artifact-graph 根目录
 *   E2E_TEST_ASSISTANT_ROOT       — artifact-chain-assistant 根目录
 *   Registry 从已安装的 agent-method-registry 包导入
 */

import { readFileSync, writeFileSync, readdirSync, statSync, accessSync, constants as fsConstants, realpathSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  assertCatalogConsistency,
  assertManifestHandlerConsistency,
  loadFindingCatalog,
  loadFindingManifest,
} from './lib/finding-manifest.mjs';
import { FINDING_HANDLERS, REPAIR_HANDLERS } from './lib/finding-handlers.mjs';
import { diagnoseExternalRoots, resolveConformanceDir } from './lib/precondition-diagnostics.mjs';

const pluginRoot = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const jsonMode = process.argv.includes('--json');
const finalizeAttestation = process.argv.includes('--finalize-attestation');
let bundleDigest = 'unknown';

// ─── Result Envelope ───

// ─── 外部 CLI 预取池（方案 C：同参去重 + I/O 并发，输出语义不变） ───
// 冻结方向：独立外部 CLI 调用在消费前并发启动（I/O 型检查的异步并发），
// 相同参数（命令+参数+stdin）在单进程生命周期内去重一次调用、复用结果；
// 缓存不落盘、不跨进程、不跨运行（不产生陈旧真值）。每个消费点仍按
// 原有串行顺序取结果并走原有失败处理，输出检查清单逐项不变。
const cliPool = new Map();
const cliPoolTmpdirs = [];

function prefetchCli(args, options = {}) {
  const key = JSON.stringify([args, options.input ?? null]);
  if (!cliPool.has(key)) {
    cliPool.set(key, new Promise((resolve) => {
      execFile(args[0], args.slice(1), {
        encoding: 'utf8',
        timeout: options.timeout ?? 30000,
        ...(options.input !== undefined ? { input: options.input } : {}),
      }, (error, stdout, stderr) => {
        resolve({ error: error || null, stdout, stderr });
      });
    }));
  }
  return cliPool.get(key);
}

// 以 execFileSync 同形语义取预取结果：非零退出/超时/派生失败一律抛错
async function takeCli(args, options = {}) {
  const { error, stdout, stderr } = await prefetchCli(args, options);
  if (error) {
    const syncError = new Error(error.message || `Command failed: ${args.join(' ')}`);
    syncError.stdout = error.stdout ?? stdout;
    syncError.stderr = error.stderr ?? stderr;
    throw syncError;
  }
  return stdout;
}

// 预取阶段创建的独立临时目录统一在进程退出时清理（早退路径不泄漏）
process.on('exit', () => {
  for (const dir of cliPoolTmpdirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const results = {
  timestamp: new Date().toISOString(),
  status: 'PASS',
  checks: [],
  warnings: [],
  errors: [],
  attestation: null,
};

function pass(name, detail) {
  results.checks.push({ name, status: 'PASS', ...(detail || {}) });
}

function fail(name, message, detail) {
  results.checks.push({ name, status: 'FAIL', error: message, ...(detail || {}) });
  results.errors.push(`${name}: ${message}`);
  results.status = 'FAIL';
}

function blocked(name, message) {
  results.checks.push({ name, status: 'BLOCKED', error: message });
  results.errors.push(`${name}: ${message}`);
  if (results.status !== 'FAIL') results.status = 'BLOCKED';
}

// ─── Canonical hash helpers (recursive key sort, matching Registry internals) ───
function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson).sort((a, b) => {
      const sa = JSON.stringify(a), sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalizeJson(value[key]);
  }
  return sorted;
}

function computeContentHash(data) {
  const canonical = JSON.stringify(canonicalizeJson(data));
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

// ─── 0. Conformance attestation dir (parallel-run isolation, fail closed) ───
// 默认 <pluginRoot>/conformance；并行 run/测试可通过 E2E_TEST_CONFORMANCE_DIR
// 绑定各自独立的绝对路径目录，互不可见、互不覆盖。相对路径失败关闭。
let conformanceDir;
try {
  conformanceDir = resolveConformanceDir({ env: process.env, pluginRoot });
  if (conformanceDir !== join(pluginRoot, 'conformance')) {
    pass('conformance-dir.override', { path: conformanceDir });
  }
} catch {
  fail('conformance-dir.override', 'CONFORMANCE_DIR_INVALID (E2E_TEST_CONFORMANCE_DIR 必须为绝对路径)');
  emit();
  process.exit(1);
}

// ─── 1. Authority Tool Environment (fail closed, explicit preconditions) ───
// 三个外部 root 前置条件统一由 precondition-diagnostics 显式诊断：
// 缺失时报告每个 root 的解析来源与状态，不得默认跳过。
let installedRegistryRoot = null;
try {
  installedRegistryRoot = resolve(dirname(fileURLToPath(import.meta.resolve('agent-method-registry'))), '..');
} catch {
  installedRegistryRoot = null;
}
const preconditions = diagnoseExternalRoots({
  env: process.env,
  resolvedPaths: { 'agent-method-registry': installedRegistryRoot },
});
results.preconditions = preconditions;

const authorityPaths = {};
for (const entry of preconditions.roots) {
  if (entry.status === 'present') {
    authorityPaths[entry.root] = { root: entry.path, cli: entry.cliPath };
    pass(`authority.${entry.root}.present`);
    continue;
  }
  if (entry.status === 'missing-env') {
    blocked(`authority.${entry.root}.env`, `${entry.envVar} 未设置`);
  } else if (entry.status === 'cli-missing') {
    blocked(`authority.${entry.root}.cli`, `${entry.cliPath} 不可执行`);
  } else {
    blocked(`authority.${entry.root}.accessible`, entry.detail);
  }
}

if (results.status === 'BLOCKED') { emit(); process.exit(1); }

// ─── 独立外部 CLI 并发预取（I/O 型；消费点仍按原串行顺序取结果） ───
// 预取输入与既有各调用点逐字节一致（同 CLI、同参数、同 stdin、同 timeout）。
const POSITIVE_ARTIFACT_DATA = JSON.parse(readFileSync(join(pluginRoot, 'fixtures', 'positive', 'artifact.json'), 'utf8'));
const SCHEMA_NEG_ARTIFACT_DATA = JSON.parse(readFileSync(join(pluginRoot, 'fixtures', 'schema-negative', 'artifact-no-relations.json'), 'utf8'));
const LEGACY_NEG_ARTIFACT_DATA = JSON.parse(readFileSync(join(pluginRoot, 'fixtures', 'negative', 'artifact-no-relations.json'), 'utf8'));

prefetchCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], { timeout: 30000 });
prefetchCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', 'artifact.e2e-test@1', '--data', JSON.stringify(POSITIVE_ARTIFACT_DATA), '--format', 'json'], { timeout: 30000 });
prefetchCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', 'artifact.e2e-test@1', '--data', JSON.stringify(SCHEMA_NEG_ARTIFACT_DATA), '--format', 'json'], { timeout: 30000 });
prefetchCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', 'artifact.e2e-test@1', '--data', JSON.stringify(LEGACY_NEG_ARTIFACT_DATA), '--format', 'json'], { timeout: 30000 });
prefetchCli(['node', join(pluginRoot, 'scripts', 'bundle-digest.mjs'), '--json'], { timeout: 30000 });
prefetchCli(['node', authorityPaths['artifact-chain-assistant'].cli,
  `--api=${join(authorityPaths['artifact-chain-assistant'].root, 'family-apis', 'e2e-test', 'api.json')}`,
  `--implementation=${join(pluginRoot, 'family', 'implementation.yaml')}`,
  `--registry-command=${authorityPaths['agent-method-registry'].cli}`,
], { timeout: 60000 });


// ─── 2. Authority Revision Digest Verification（从 api.json 读取，非硬编码）───
const authorityApiSnapshot = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
let CONTRACT_DIGEST = null;
const API_DIGEST = authorityApiSnapshot.api.revisionDigest;

try {
  const explainOut = await takeCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], { timeout: 30000 });
  const explain = JSON.parse(explainOut);
  const resolvedDigest = explain.data?.identity?.revisionDigest;
  if (explain.ok && explain.data?.identity?.major === 'artifact.e2e-test@1' && /^sha256:[a-f0-9]{64}$/.test(resolvedDigest || '')) {
    CONTRACT_DIGEST = resolvedDigest;
    pass('contract.revision-digest', { digest: CONTRACT_DIGEST, authority: 'artifact-graph contract explain' });
  } else {
    fail('contract.revision-digest', 'artifact-graph did not return the authoritative artifact.e2e-test@1 identity');
  }
} catch (err) {
  fail('contract.revision-digest', err.message);
}

// facts 依赖 contract digest：§2 完成后写入并并发预取 method-query，
// 与 §3-§6e 的本地检查重叠；消费点仍在 §6g-pre 按原序取结果。
const factsTmpDir = mkdtempSync(join(tmpdir(), 'e2e-conformance-facts-'));
cliPoolTmpdirs.push(factsTmpDir);
const factsFile = join(factsTmpDir, 'raw-facts.json');
writeFileSync(factsFile, JSON.stringify({
  projectRoot: pluginRoot,
  configDigest: computeContentHash({ project: 'e2e-test', version: JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version, root: pluginRoot }),
  artifactGraphSummary: { artifactCount: 0, edgeCount: 0, contextTargets: [] },
  targetArtifact: { type: 'feature', id: 'F-001' },
  contractRevisionDigest: CONTRACT_DIGEST,
  proofStatus: 'present',
  versionLockStatus: 'fresh',
  sourcesFreshness: 'fresh',
  bindingFreshness: 'fresh',
}, null, 2), 'utf8');
prefetchCli(['node', join(authorityPaths['artifact-chain-assistant'].root, 'scripts', 'method-query.mjs'), 'build-envelope', factsFile], { timeout: 30000 });

// ─── 3. AJV Schema Validation ───
let Ajv;
try { Ajv = (await import('ajv')).default; } catch { Ajv = require('ajv'); }
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

const SCHEMA_DIR = join(pluginRoot, 'schemas');
const REQUIRED_SCHEMAS = [
  'inspection.json', 'candidate-assessment.json', 'matrix.json', 'proof-binding.json',
  'stage-result.json', 'review-result.json', 'artifact-package-manifest.json',
  'finding-capability-manifest.json', 'author-raw-input.json', 'preview-manifest.json',
  'forward-trial-rubric.json', 'forward-trial-rubric-review.json', 'forward-reviewer-packet.json',
  'method-forward-host-receipt.json', 'method-forward-trial-result.json', 'method-forward-qualification.json',
];

const compiledSchemas = {};
for (const schemaFile of REQUIRED_SCHEMAS) {
  try {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, schemaFile), 'utf8'));
    if (!schema.$schema || !schema.$id || !schema.title) { fail(`schema.${schemaFile}.meta`, 'missing $schema, $id, or title'); continue; }
    try { compiledSchemas[schemaFile] = ajv.compile(schema); pass(`schema.${schemaFile}.compiled`); } catch (err) { fail(`schema.${schemaFile}.compile`, err.message); }
  } catch (err) { fail(`schema.${schemaFile}.load`, err.message); }
}

// ─── 3b. Finding Capability Manifest ↔ handlers ↔ catalog ───
try {
  const { manifest, digest } = loadFindingManifest(pluginRoot);
  pass('finding-capability-manifest.valid', { digest });
  const handlerConsistency = assertManifestHandlerConsistency(manifest, {
    handlers: FINDING_HANDLERS,
    repairHandlers: REPAIR_HANDLERS,
  });
  handlerConsistency.consistent
    ? pass('finding-capability-manifest.handlers-consistent')
    : fail('finding-capability-manifest.handlers-consistent', 'MANIFEST_HANDLER_MISMATCH', handlerConsistency);
  const catalogConsistency = assertCatalogConsistency(manifest, loadFindingCatalog(pluginRoot));
  catalogConsistency.consistent
    ? pass('finding-capability-manifest.catalog-consistent')
    : fail('finding-capability-manifest.catalog-consistent', 'MANIFEST_CATALOG_MISMATCH', catalogConsistency);
} catch (error) {
  fail('finding-capability-manifest.valid', error.message);
}

// ─── 4. Positive Fixture Validation (AJV + artifact-graph contract) ───
const POSITIVE_DIR = join(pluginRoot, 'fixtures', 'positive');
const positiveFixtures = [
  { file: 'inspection.json', schema: 'inspection.json' },
  { file: 'candidate-assessment.json', schema: 'candidate-assessment.json' },
  { file: 'matrix.json', schema: 'matrix.json' },
  { file: 'artifact.json', schema: null, contract: 'artifact.e2e-test@1' },
  { file: 'review-result.json', schema: 'review-result.json' },
  { file: 'proof-binding.json', schema: 'proof-binding.json' },
];

for (const pf of positiveFixtures) {
  try {
    const data = JSON.parse(readFileSync(join(POSITIVE_DIR, pf.file), 'utf8'));
    const fixtureDigest = computeContentHash(data);
    if (pf.schema && compiledSchemas[pf.schema]) {
      const valid = compiledSchemas[pf.schema](data);
      valid ? pass(`positive.${pf.file}.schema-valid`, { fixtureDigest }) : fail(`positive.${pf.file}.schema-valid`, ajv.errorsText(compiledSchemas[pf.schema].errors));
    }
    if (pf.contract) {
      try {
        const out = await takeCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', pf.contract, '--data', JSON.stringify(data), '--format', 'json'], { timeout: 30000 });
        const res = JSON.parse(out);
        (res.ok && res.data?.valid) ? pass(`positive.${pf.file}.contract-valid`, { fixtureDigest }) : fail(`positive.${pf.file}.contract-valid`, JSON.stringify(res.errors));
      } catch (err) { fail(`positive.${pf.file}.contract-valid`, err.message); }
    }
  } catch (err) { fail(`positive.${pf.file}.load`, err.message); }
}

// ─── 5. Schema-Negative Fixture Validation (must fail at schema level) ───
const SCHEMA_NEG_DIR = join(pluginRoot, 'fixtures', 'schema-negative');
const schemaNegFixtures = [
  { file: 'inspection-missing-context.json', schema: 'inspection.json', expectFail: true },
  { file: 'candidate-no-criteria.json', schema: 'candidate-assessment.json', expectFail: true },
  { file: 'matrix-missing-dimension.json', schema: 'matrix.json', expectFail: true },
  { file: 'artifact-no-relations.json', schema: null, contract: 'artifact.e2e-test@1', expectFail: true },
];

for (const nf of schemaNegFixtures) {
  try {
    const data = JSON.parse(readFileSync(join(SCHEMA_NEG_DIR, nf.file), 'utf8'));
    const fixtureDigest = computeContentHash(data);
    if (nf.schema && compiledSchemas[nf.schema]) {
      const valid = compiledSchemas[nf.schema](data);
      !valid ? pass(`schema-negative.${nf.file}.schema-rejected`, { errors: compiledSchemas[nf.schema].errors?.length, fixtureDigest })
        : fail(`schema-negative.${nf.file}.schema-rejected`, 'negative fixture passed AJV validation unexpectedly');
    }
    if (nf.contract) {
      try {
        const out = await takeCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', nf.contract, '--data', JSON.stringify(data), '--format', 'json'], { timeout: 30000 });
        const res = JSON.parse(out);
        (!res.ok || !res.data?.valid) ? pass(`schema-negative.${nf.file}.contract-rejected`, { fixtureDigest }) : fail(`schema-negative.${nf.file}.contract-rejected`, 'passed unexpectedly');
      } catch { pass(`schema-negative.${nf.file}.contract-rejected`); }
    }
  } catch (err) { fail(`schema-negative.${nf.file}.load`, err.message); }
}

// Also verify legacy negative/ fixtures are still present and still fail (backward compat)
const NEGATIVE_DIR = join(pluginRoot, 'fixtures', 'negative');
const legacyNegFixtures = [
  { file: 'inspection-missing-context.json', schema: 'inspection.json' },
  { file: 'candidate-no-criteria.json', schema: 'candidate-assessment.json' },
  { file: 'matrix-missing-dimension.json', schema: 'matrix.json' },
  { file: 'artifact-no-relations.json', schema: null, contract: 'artifact.e2e-test@1' },
];
for (const nf of legacyNegFixtures) {
  try {
    const data = JSON.parse(readFileSync(join(NEGATIVE_DIR, nf.file), 'utf8'));
    const fixtureDigest = computeContentHash(data);
    if (nf.schema && compiledSchemas[nf.schema]) {
      const valid = compiledSchemas[nf.schema](data);
      !valid ? pass(`legacy-negative.${nf.file}.still-rejected`, { fixtureDigest }) : fail(`legacy-negative.${nf.file}.still-rejected`, 'legacy negative no longer fails');
    }
    if (nf.contract) {
      try {
        const out = await takeCli(['node', authorityPaths['artifact-graph'].cli, 'contract', 'validate', '--contract', nf.contract, '--data', JSON.stringify(data), '--format', 'json'], { timeout: 30000 });
        const res = JSON.parse(out);
        (!res.ok || !res.data?.valid) ? pass(`legacy-negative.${nf.file}.contract-rejected`, { fixtureDigest }) : fail(`legacy-negative.${nf.file}.contract-rejected`, 'passed unexpectedly');
      } catch { pass(`legacy-negative.${nf.file}.contract-rejected`); }
    }
  } catch (err) { fail(`legacy-negative.${nf.file}.load`, err.message); }
}

// ─── 6. Registry v2 Full SPI Chain (public API) ───
// Load Registry public API from installed package
let registryApi;
try {
  registryApi = await import('agent-method-registry');
  pass('registry-v2.api.importable');
} catch (err) {
  fail('registry-v2.api.importable', err.message);
  emit();
  process.exit(1);
}

const { validateCatalog, validateProjectOverlay, buildEffectiveIndex, queryEffectiveIndex, resolveEntry, verifyProvider, computeContentHash: registryComputeHash } = registryApi;

// 6a. Validate implementation descriptor via Registry
const implPath = join(pluginRoot, 'family', 'implementation.yaml');
const implContent = readFileSync(implPath, 'utf8');
// Parse YAML manually (minimal: we know the structure)
const implData = parseImplYaml(implContent);
try {
  const result = validateCatalog(implData);
  result.ok ? pass('registry-v2.implementation-valid') : fail('registry-v2.implementation-valid', result.diagnostics.map(d => d.message).join('; '));
} catch (err) {
  fail('registry-v2.implementation-valid', err.message);
}

// 6b. Compute real package digest (hash of package.json as local stand-in)
const packageJsonPath = join(pluginRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const packageDigest = computeContentHash(packageJson);
pass('registry-v2.package-digest', { digest: packageDigest });

// 6c. Bundle digest: use descriptor's declared treeDigest as authority.
//     bundle-digest.mjs now uses the same algorithm as Registry computeBundleTreeDigest;
//     verify alignment by running bundle-digest.mjs and comparing against declared value.
const declaredTreeDigest = implData.bundle?.treeDigest;
if (!declaredTreeDigest) {
  fail('registry-v2.bundle-digest.declared', 'implementation.yaml missing bundle.treeDigest');
  bundleDigest = 'sha256:' + '0'.repeat(64);
} else {
  bundleDigest = declaredTreeDigest;
  // Verify algorithm alignment: bundle-digest.mjs output must match declared value
  try {
    const bundleOut = await takeCli(['node', join(pluginRoot, 'scripts', 'bundle-digest.mjs'), '--json'], { timeout: 30000 });
    const computed = JSON.parse(bundleOut).digest;
    if (computed === declaredTreeDigest) {
      pass('registry-v2.bundle-digest.aligned', { digest: bundleDigest });
    } else {
      fail('registry-v2.bundle-digest.aligned', `algorithm drift: bundle-digest.mjs=${computed}, declared=${declaredTreeDigest}`);
    }
  } catch (err) {
    fail('registry-v2.bundle-digest.aligned', err.message);
  }
  pass('registry-v2.bundle-digest', { digest: bundleDigest });
}

// 6d2. Two-phase attestation: default read-only, explicit --finalize-attestation updates descriptor.
//      binding uses descriptor's current declared value (no pre-attestation fabrication).
const declaredAttestation = implData.conformance?.deterministicAttestation || null;

// 6e. Build inventory entries (one per host)
const canonicalRoot = pluginRoot;
const hosts = ['codex', 'claude-code'];
const inventoryEntries = [];
for (const host of hosts) {
  inventoryEntries.push({
    pluginId: 'e2e-test',
    canonicalRoot,
    version: packageJson.version,
    packageDigest,
    provenance: 'local',
    host,
  });
}

// Validate inventory as standalone document
const inventoryDoc = {
  documentKind: 'v2-inventory',
  schemaVersion: 2,
  snapshotDigest: computeContentHash({ entries: inventoryEntries }),
  snapshotFreshness: 'fresh',
  entries: inventoryEntries,
};
try {
  const out = await takeCli(['node', authorityPaths['agent-method-registry'].cli, 'validate', '--catalog', '-'], { timeout: 30000, input: JSON.stringify(inventoryDoc) });
  const res = JSON.parse(out);
  res.ok ? pass('registry-v2.spi.inventory-valid') : fail('registry-v2.spi.inventory-valid', res.diagnostics?.map(d => d.message).join('; '));
} catch (err) {
  // CLI validate with stdin may not work; use API
  try {
    const catResult = validateCatalog(inventoryDoc);
    catResult.ok ? pass('registry-v2.spi.inventory-valid') : fail('registry-v2.spi.inventory-valid', catResult.diagnostics.map(d => d.message).join('; '));
  } catch (err2) {
    fail('registry-v2.spi.inventory-valid', err2.message);
  }
}

// 6f. Build binding (single host per binding — mixSafe: false requires atomic family)
//     Authorization uses write-project-artifacts to cover all service ceilings
//     (write-authorized-artifacts and write-review-result are orthogonal).
function makeBindingDoc(host) {
  return {
    documentKind: 'v2-binding',
    schemaVersion: 2,
    bindings: [{
      familyId: 'e2e-test',
      apiIdentity: { apiId: 'artifact.e2e-test-family', apiMajor: 1, apiRevisionDigest: API_DIGEST },
      implementationIdentity: { familyImplementationId: 'io.github.mzdbxqh.e2e-test', version: packageJson.version },
      providerSelector: { scope: 'plugin', pluginId: 'e2e-test', host, canonicalRoot, packageDigest, bundleDigest, provenance: 'local' },
      selectionSource: 'project-binding',
      conformanceEvidence: { deterministicAttestation: declaredAttestation, behaviorQualification: null },
      authorization: { sideEffectBudget: 'write-project-artifacts', granted: true },
    }],
  };
}

// Validate binding (use first host as representative)
const bindingDoc = makeBindingDoc('claude-code');
try {
  const bindResult = validateProjectOverlay(bindingDoc);
  bindResult.ok ? pass('registry-v2.spi.binding-valid') : fail('registry-v2.spi.binding-valid', bindResult.diagnostics.map(d => d.message).join('; '));
} catch (err) {
  fail('registry-v2.spi.binding-valid', err.message);
}

// 6g-pre. Generate Project Facts Evidence via assistant producer ───
// Must use assistant's build-envelope to produce valid evidence; do NOT copy digest algorithm.
const projectFactsEvidence = await (async () => {
  // facts 文件与 method-query 调用已并发预取（§2 后启动，tmpdir 由
  // cliPoolTmpdirs 统一在进程退出时清理，早退路径不泄漏）；此处按原
  // 串行顺序取结果并走原有失败处理。
  try {
    const out = await takeCli(['node', join(authorityPaths['artifact-chain-assistant'].root, 'scripts', 'method-query.mjs'), 'build-envelope', factsFile], { timeout: 30000 });

    const result = JSON.parse(out);
    if (result.ok && result.status === 'READY' && result.envelope) {
      pass('project-facts-evidence.produced', { evidenceDigest: result.envelope.evidenceDigest });
      return result.envelope;
    } else {
      fail('project-facts-evidence.produced', `status=${result.status}, errors=${JSON.stringify(result.errors)}`);
      return null;
    }
  } catch (err) {
    fail('project-facts-evidence.produced', err.message);
    return null;
  }
})();

if (!projectFactsEvidence) {
  emit();
  process.exit(1);
}

// 6g-i. Full SPI chain per host: projection → query → resolve → run-lock → reverify
const familyApiDef = implDataToFamilyApi(implData);
const SERVICES = [
  { serviceId: 'artifact.e2e-test.help', intent: 'help', kind: 'operation', ref: 'artifact.e2e-test.help', skill: 'skills/e2e-test-help', ceiling: 'read-only' },
  { serviceId: 'artifact.e2e-test.default', intent: 'default', kind: 'workflow', ref: 'artifact.e2e-test.default', skill: 'skills/e2e-test', ceiling: 'write-authorized-artifacts' },
  { serviceId: 'artifact.e2e-test.author', intent: 'author', kind: 'workflow', ref: 'artifact.e2e-test.author', skill: 'skills/e2e-test-author', ceiling: 'write-authorized-artifacts' },
  { serviceId: 'artifact.e2e-test.review', intent: 'review', kind: 'workflow', ref: 'artifact.e2e-test.review', skill: 'skills/e2e-test-review', ceiling: 'write-review-result' },
  { serviceId: 'artifact.e2e-test.repair', intent: 'repair', kind: 'workflow', ref: 'artifact.e2e-test.repair', skill: 'skills/e2e-test-repair', ceiling: 'write-authorized-artifacts' },
];

const runLocks = {};
let projection;

for (const host of hosts) {
  const hostBinding = makeBindingDoc(host);

  // 6g. Build projection for this host
  let hostProjection;
  try {
    const hostInvEntries = inventoryEntries.filter(e => e.host === host);
    const result = buildEffectiveIndex({
      familyApi: familyApiDef,
      implementations: [implData],
      inventoryEntries: hostInvEntries,
      bindings: hostBinding,
    });
    if (result.ok) {
      hostProjection = result.index;
      if (!projection) projection = hostProjection; // keep first for query test
      pass(`registry-v2.spi.projection.${host}`, {
        entryCount: hostProjection.entries?.length,
        diagnostics: result.diagnostics?.map(d => ({ code: d.code, message: d.message })),
        candidateStates: hostProjection.entries?.map(entry => ({
          serviceId: entry.serviceId,
          trust: entry.trust,
          resolution: entry.resolution,
          candidates: entry.candidates?.map(candidate => ({
            trust: candidate.trust,
            skillPath: candidate.provider?.skillPath,
            verificationAttestationDigest: candidate.verificationAttestationDigest,
          })),
        })),
      });
    } else {
      fail(`registry-v2.spi.projection.${host}`, result.diagnostics.map(d => d.message).join('; '));
    }
  } catch (err) {
    fail(`registry-v2.spi.projection.${host}`, err.message);
  }

  // 6g2. verifyProvider v2: observe actual bundleDigest from filesystem via Registry algorithm
  if (hostProjection) {
    const hostInvEntry = inventoryEntries.find(e => e.host === host);
    const providerEntry = hostProjection.entries?.find(e => e.candidates?.length > 0);
    const candidate = providerEntry?.candidates?.[0];
    if (candidate?.provider && hostInvEntry) {
      try {
        const vpResult = verifyProvider({
          host,
          v2: {
            implementation: implData,
            inventoryEntry: hostInvEntry,
            providerInstance: candidate.provider,
            inventorySnapshot: { digest: computeContentHash({ entries: [hostInvEntry] }), freshness: 'fresh' },
          },
        });
        if (vpResult.status === 'verified' && vpResult.observed?.bundleDigest) {
          const observed = vpResult.observed.bundleDigest;
          if (observed === bundleDigest) {
            pass(`registry-v2.spi.verify-provider.${host}`, { observed, match: true });
          } else {
            fail(`registry-v2.spi.verify-provider.${host}`, `observed ${observed} != declared ${bundleDigest}`);
          }
        } else {
          fail(`registry-v2.spi.verify-provider.${host}`, vpResult.diagnostics.map(d => d.message).join('; '));
        }
      } catch (err) {
        fail(`registry-v2.spi.verify-provider.${host}`, err.message);
      }
    }
  }

  // 6h. Query projection for this host using methodQueryCandidate
  if (hostProjection) {
    try {
      const queryResult = queryEffectiveIndex({
        index: hostProjection,
        methodQueryCandidate: {
          mode: 'standard',
          intent: 'author',
          kind: 'workflow',
          projectFactsEvidence,
          authorization: {
            sideEffectBudget: 'write-project-artifacts',
            granted: true,
          },
        },
        purpose: 'prepare',
      });
      if (queryResult.ok) {
        const matchCount = Array.isArray(queryResult.data) ? queryResult.data.length : (queryResult.data?.entries?.length ?? 0);
        pass(`registry-v2.spi.query.${host}`, { matchCount });
      } else {
        fail(`registry-v2.spi.query.${host}`, queryResult.diagnostics.map(d => d.message).join('; '));
      }
    } catch (err) {
      fail(`registry-v2.spi.query.${host}`, err.message);
    }
  }

  // 6i. Resolve each service for this host using preparedQueryHandle
  if (hostProjection) {
    for (const svc of SERVICES) {
      // Create methodQueryCandidate for this specific service
      const queryResult = queryEffectiveIndex({
        index: hostProjection,
        methodQueryCandidate: {
          mode: 'standard',
          intent: svc.intent,
          kind: svc.kind,
          projectFactsEvidence,
          authorization: {
            sideEffectBudget: svc.ceiling,
            granted: svc.ceiling !== 'read-only',
          },
        },
        purpose: 'prepare',
      });

      if (queryResult.ok && queryResult.preparedQueryHandle) {
        const preparedQueryHandle = queryResult.preparedQueryHandle;
        const serviceIdentity = preparedQueryHandle.candidateServices.find(s => s.serviceId === svc.serviceId);
        if (!serviceIdentity) {
          fail(`registry-v2.spi.resolve.${svc.intent}.${host}`, `Service ${svc.serviceId} not found in preparedQueryHandle`);
          continue;
        }

        try {
          const resolveResult = resolveEntry({
            index: hostProjection,
            ref: svc.ref,
            host,
            pluginRoots: { [packageJson.name]: [canonicalRoot] },
            preparedQueryHandle,
            serviceIdentity,
            strictProvider: true,
          });
          if (resolveResult.ok) {
            const lock = resolveResult.data.runMethodLock;
            if (lock) {
              runLocks[`${svc.ref}@${host}`] = lock;
              try {
                const lockResult = validateCatalog(lock);
                lockResult.ok
                  ? pass(`registry-v2.spi.resolve.${svc.intent}.${host}.lock-valid`)
                  : fail(`registry-v2.spi.resolve.${svc.intent}.${host}.lock-valid`, lockResult.diagnostics.map(d => d.message).join('; '));
              } catch (err) { fail(`registry-v2.spi.resolve.${svc.intent}.${host}.lock-valid`, err.message); }
            }
            pass(`registry-v2.spi.resolve.${svc.intent}.${host}`, { entry: resolveResult.data.entry?.ref, resolution: resolveResult.data.entry?.resolution });
          } else {
            fail(`registry-v2.spi.resolve.${svc.intent}.${host}`, resolveResult.diagnostics.map(d => d.message).join('; '));
          }
        } catch (err) {
          fail(`registry-v2.spi.resolve.${svc.intent}.${host}`, err.message);
        }
      } else {
        fail(`registry-v2.spi.resolve.${svc.intent}.${host}.query`, queryResult.diagnostics.map(d => d.message).join('; '));
      }
    }
  }
}

// 6j. Reverify: verify provider from run-lock with host context
for (const [key, lock] of Object.entries(runLocks)) {
  try {
    const host = lock.provider.host;
    const inventoryEntry = inventoryEntries.find(e => e.host === host);
    if (!inventoryEntry) {
      fail(`registry-v2.spi.reverify.${key}`, `No inventory entry found for host ${host}`);
      continue;
    }

    const vResult = verifyProvider({
      host,
      runLock: { ...lock, inventoryEntry },
    });
    vResult.status === 'verified'
      ? pass(`registry-v2.spi.reverify.${key}`, { verifyStatus: vResult.status })
      : fail(`registry-v2.spi.reverify.${key}`, vResult.diagnostics.map(d => d.message).join('; '));
  } catch (err) {
    fail(`registry-v2.spi.reverify.${key}`, err.message);
  }
}

// 6k. Mutation tests: tamper bundle/digest/host/version → must reject
{
  const testHost = 'claude-code';
  const baseBinding = makeBindingDoc(testHost);
  const hostInvEntries = inventoryEntries.filter(e => e.host === testHost);

  // Tamper: wrong bundle digest
  const tampered = JSON.parse(JSON.stringify(baseBinding));
  tampered.bindings[0].providerSelector.bundleDigest = 'sha256:' + 'aa'.repeat(32);
  try {
    const r = buildEffectiveIndex({ familyApi: familyApiDef, implementations: [implData], inventoryEntries: hostInvEntries, bindings: tampered });
    if (!r.ok) { pass('registry-v2.mutation.tampered-bundle-rejected'); }
    else {
      const e = r.index.entries.find(x => x.serviceId === SERVICES[0].serviceId);
      (e && e.resolution === 'NONE') ? pass('registry-v2.mutation.tampered-bundle-rejected', { resolution: 'NONE' }) : fail('registry-v2.mutation.tampered-bundle-rejected', 'Tampered bundle was not rejected');
    }
  } catch (err) { fail('registry-v2.mutation.tampered-bundle-rejected', err.message); }

  // Tamper: wrong host in binding (host not in inventory)
  const wrongHost = JSON.parse(JSON.stringify(baseBinding));
  wrongHost.bindings[0].providerSelector.host = 'nonexistent-host';
  try {
    const r = buildEffectiveIndex({ familyApi: familyApiDef, implementations: [implData], inventoryEntries: hostInvEntries, bindings: wrongHost });
    if (!r.ok) { pass('registry-v2.mutation.wrong-host-rejected'); }
    else {
      const e = r.index.entries.find(x => x.serviceId === SERVICES[0].serviceId);
      (e && (e.resolution === 'NONE' || e.resolution === 'AMBIGUOUS')) ? pass('registry-v2.mutation.wrong-host-rejected', { resolution: e.resolution }) : fail('registry-v2.mutation.wrong-host-rejected', 'Wrong host was not rejected');
    }
  } catch (err) { fail('registry-v2.mutation.wrong-host-rejected', err.message); }

  // Tamper: wrong version
  const wrongVer = JSON.parse(JSON.stringify(baseBinding));
  wrongVer.bindings[0].implementationIdentity.version = '999.0.0';
  try {
    const r = buildEffectiveIndex({ familyApi: familyApiDef, implementations: [implData], inventoryEntries: hostInvEntries, bindings: wrongVer });
    if (!r.ok) { pass('registry-v2.mutation.wrong-version-rejected'); }
    else {
      const e = r.index.entries.find(x => x.serviceId === SERVICES[0].serviceId);
      (e && (e.resolution === 'NONE' || e.installation === 'NOT_INSTALLED')) ? pass('registry-v2.mutation.wrong-version-rejected') : fail('registry-v2.mutation.wrong-version-rejected', 'Wrong version was not rejected');
    }
  } catch (err) { fail('registry-v2.mutation.wrong-version-rejected', err.message); }

  // Tamper: caller host swap on runLock (lock for codex, caller says claude-code → must reject)
  const codexLock = Object.entries(runLocks).find(([k]) => k.endsWith('@codex'));
  if (codexLock) {
    const [lockKey, lock] = codexLock;
    const codexInvEntry = inventoryEntries.find(e => e.host === 'codex');
    if (codexInvEntry) {
      try {
        // Call verifyProvider with mismatched host (claude-code calling codex lock)
        const swapResult = verifyProvider({
          host: 'claude-code',
          runLock: { ...lock, inventoryEntry: codexInvEntry },
        });
        swapResult.status !== 'verified'
          ? pass('registry-v2.mutation.caller-host-swap-rejected', { verifyStatus: swapResult.status, mismatchCode: swapResult.diagnostics?.[0]?.code })
          : fail('registry-v2.mutation.caller-host-swap-rejected', 'Host swap was not rejected');
      } catch (err) { fail('registry-v2.mutation.caller-host-swap-rejected', err.message); }
    }
  }

  // Tamper: no-binding authorization denied
  const noAuthBinding = JSON.parse(JSON.stringify(baseBinding));
  noAuthBinding.bindings[0].authorization = { sideEffectBudget: 'write-authorized-artifacts', granted: false };
  try {
    const r = buildEffectiveIndex({ familyApi: familyApiDef, implementations: [implData], inventoryEntries: hostInvEntries, bindings: noAuthBinding });
    if (r.ok) {
      const e = r.index.entries.find(x => x.serviceId === SERVICES[0].serviceId);
      if (e) {
        const hasAuth = e.candidates?.some(c => c.authorization?.granted);
        !hasAuth ? pass('registry-v2.mutation.no-auth-rejected') : fail('registry-v2.mutation.no-auth-rejected', 'Authorization was not denied');
      } else {
        pass('registry-v2.mutation.no-auth-rejected');
      }
    } else {
      pass('registry-v2.mutation.no-auth-rejected');
    }
  } catch (err) { fail('registry-v2.mutation.no-auth-rejected', err.message); }
}

// 6l. No-binding test: all services should be NOT_ENABLED
try {
  const noBindingResult = buildEffectiveIndex({
    familyApi: familyApiDef,
    implementations: [implData],
    inventoryEntries: inventoryEntries.filter(e => e.host === 'claude-code'),
  });
  if (noBindingResult.ok) {
    const allNotEnabled = noBindingResult.index.entries.every(e => e.enablement === 'NOT_ENABLED' || e.resolution === 'NONE');
    allNotEnabled ? pass('registry-v2.spi.no-binding-all-not-enabled') : fail('registry-v2.spi.no-binding-all-not-enabled', 'Some services resolved without binding');
  } else {
    pass('registry-v2.spi.no-binding-all-not-enabled', { note: 'projection without binding failed as expected' });
  }
} catch (err) {
  fail('registry-v2.spi.no-binding-all-not-enabled', err.message);
}

// ─── 7. Family API Compile (full facade) ───
const apiPath = join(authorityPaths['artifact-chain-assistant'].root, 'family-apis/e2e-test/api.json');
try {
  const out = await takeCli(['node', authorityPaths['artifact-chain-assistant'].cli,
    `--api=${apiPath}`,
    `--implementation=${implPath}`,
    `--registry-command=${authorityPaths['agent-method-registry'].cli}`,
  ], { timeout: 60000 });
  const res = JSON.parse(out);
  res.ok ? pass('family-compile.full', { familyConformance: res.familyConformance?.status }) : fail('family-compile.full', JSON.stringify(res));
} catch (err) {
  fail('family-compile.full', err.message);
}

// ─── 8. Findings Catalog Completeness ───
try {
  const catalogContent = readFileSync(join(pluginRoot, 'references', 'findings-catalog.md'), 'utf8');
  let allPresent = true;
  for (let i = 1; i <= 12; i++) {
    const id = `E2E-F-${String(i).padStart(3, '0')}`;
    if (!catalogContent.includes(id)) { fail('findings-catalog.complete', `missing ${id}`); allPresent = false; break; }
  }
  if (allPresent) pass('findings-catalog.complete');
} catch (err) { fail('findings-catalog.complete', err.message); }

// ─── 9. References Completeness ───
try {
  const refs = ['methodology.md', 'candidate-assessment.md', 'matrix-model.md', 'findings-catalog.md', 'proof-reconciliation.md'];
  refs.every(r => { try { statSync(join(pluginRoot, 'references', r)); return true; } catch { return false; } })
    ? pass('references.all-present') : fail('references.all-present', 'missing reference files');
} catch (err) { fail('references.all-present', err.message); }

// ─── 10. Skills Completeness ───
try {
  const skills = ['e2e-test-help', 'e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'];
  skills.every(s => { try { statSync(join(pluginRoot, 'skills', s, 'SKILL.md')); return true; } catch { return false; } })
    ? pass('skills.all-present') : fail('skills.all-present', 'missing skill files');
} catch (err) { fail('skills.all-present', err.message); }

// ─── 11. Default Not Enabled ───
try {
  if (!implContent.includes('enablement: ENABLED')) {
    pass('default-not-enabled');
  } else {
    fail('default-not-enabled', 'implementation should not be ENABLED by default');
  }
} catch (err) { fail('default-not-enabled', err.message); }

// ─── 12. Conformance Attestation (all preceding deterministic checks) ───
// The attestation covers every deterministic authority, schema, SPI, mutation,
// family-compile, reference, skill and default-state check above. It intentionally
// excludes only its own finalize/declared-match check to avoid self-reference.
const attestationInput = {
  checks: results.checks.map(({ error: _error, ...check }) => check),
  status: results.status,
};
const attestationDigest = computeContentHash(attestationInput);
results.attestation = { digest: attestationDigest, checkCount: results.checks.length };

if (finalizeAttestation) {
  if (results.status !== 'PASS') {
    fail('attestation.finalize', 'Cannot finalize attestation when conformance status is not PASS');
  } else {
    try {
      let content = readFileSync(implPath, 'utf8');
      const attestationPattern = /deterministicAttestation:\s*(sha256:[a-f0-9]{64}|null)/;
      if (attestationPattern.test(content)) {
        content = content.replace(attestationPattern, `deterministicAttestation: ${attestationDigest}`);
        // family/implementation.yaml is outside bundle roots, so this write does
        // not recursively change bundle.treeDigest.
        writeFileSync(implPath, content, 'utf8');
        const lastRun = {
          schemaVersion: 1,
          status: 'PASS',
          bundleDigest,
          attestation: { digest: attestationDigest, checkCount: results.checks.length },
        };
        mkdirSync(conformanceDir, { recursive: true });
        writeFileSync(join(conformanceDir, 'last-run.json'), `${JSON.stringify(lastRun, null, 2)}\n`, 'utf8');
        pass('attestation.finalized', { digest: attestationDigest });
      } else {
        fail('attestation.finalize', 'Could not find deterministicAttestation field in implementation.yaml');
      }
    } catch (err) {
      fail('attestation.finalize', err.message);
    }
  }
} else if (declaredAttestation) {
  if (attestationDigest === declaredAttestation) {
    pass('attestation.declared-match', { digest: attestationDigest });
  } else {
    fail('attestation.declared-match', `result ${attestationDigest} != declared ${declaredAttestation} (run --finalize-attestation to update)`);
  }
} else {
  results.warnings.push('attestation.declared-match: deterministicAttestation is null (run --finalize-attestation to set)');
}

// ─── Output ───
function emit() {
  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`Conformance Status: ${results.status}`);
    console.log(`Attestation: ${results.attestation?.digest || 'none'}`);
    console.log(`Phase: ${finalizeAttestation ? 'finalize (writing descriptor)' : 'read-only'}`);
    console.log(`Bundle Digest: ${bundleDigest}`);
    if (results.preconditions) {
      console.log();
      console.log(`External Root Preconditions: ${results.preconditions.allPresent ? 'ALL_PRESENT' : 'BLOCKED_HONEST'}`);
      for (const p of results.preconditions.roots) {
        const icon = p.status === 'present' ? '✓' : '⊘';
        console.log(`  ${icon} ${p.root}: ${p.status} [${p.resolutionSource}]${p.path ? ` path=${p.path}` : ''} (${p.detail})`);
      }
    }
    console.log();
    for (const c of results.checks) {
      const icon = c.status === 'PASS' ? '✓' : c.status === 'BLOCKED' ? '⊘' : '✗';
      console.log(`  ${icon} ${c.name}${c.error ? ` (${c.error})` : ''}`);
    }
    if (results.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of results.warnings) console.log(`  ⚠ ${w}`);
    }
    if (results.errors.length > 0) {
      console.log('\nErrors:');
      for (const e of results.errors) console.log(`  ✗ ${e}`);
    }
  }
}

emit();
process.exit(results.status === 'PASS' ? 0 : 1);

// ─── YAML parsing helper (minimal, for implementation.yaml) ───
function parseImplYaml(content) {
  const lines = content.split('\n');
  const result = {};

  // Pass 1: Parse into flat entries, merging list items with their parent key
  const entries = [];
  let lastKeyEntry = null;
  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '' || line.trim() === '---') continue;
    // List item: "  - value" — attach to most recent key entry as array element
    const listMatch = line.match(/^(\s*)- (.+)$/);
    if (listMatch) {
      const val = listMatch[2].trim();
      if (lastKeyEntry) {
        if (!Array.isArray(lastKeyEntry.value)) lastKeyEntry.value = [];
        lastKeyEntry.value.push(val);
      }
      continue;
    }
    const match = line.match(/^(\s*)(\S.*?)(?::\s*(.*))?$/);
    if (!match) continue;
    const lineIndent = match[1].length;
    const key = match[2].trim();
    let value = match[3]?.trim();
    const entry = { indent: lineIndent, key, value: value || null };
    entries.push(entry);
    lastKeyEntry = entry;
  }

  // Pass 2: Build object tree from entries
  const stack = [{ obj: result, indent: -1 }];

  for (const entry of entries) {
    while (stack.length > 1 && entry.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (Array.isArray(entry.value)) {
      parent[entry.key] = entry.value.map(v => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (v === 'null') return null;
        if (/^\d+$/.test(v)) return parseInt(v, 10);
        return v;
      });
    } else if (entry.value !== null && entry.value !== undefined) {
      let val = entry.value;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (val === 'null') val = null;
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      parent[entry.key] = val;
    } else {
      parent[entry.key] = {};
      stack.push({ obj: parent[entry.key], indent: entry.indent });
    }
  }

  return result;
}

function implDataToFamilyApi(impl) {
  return {
    api: {
      id: impl.implements?.apiId || 'artifact.e2e-test-family',
      major: impl.implements?.apiMajor || 1,
      revisionDigest: impl.implements?.apiRevisionDigest || API_DIGEST,
    },
    services: Object.entries(impl.services || {}).map(([id, svc]) => ({
      id,
      kind: id.includes('.help') ? 'operation' : 'workflow',
      intents: [id.split('.').pop()],
      summary: `E2E ${id.split('.').pop()} service`,
      sideEffectCeiling: id.includes('.help') ? 'read-only' : id.includes('.review') ? 'write-review-result' : 'write-authorized-artifacts',
      mixSafe: false,
    })),
  };
}
