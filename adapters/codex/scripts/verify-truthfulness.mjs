#!/usr/bin/env node

/**
 * E2E 技能族真实性发布门。
 *
 * 同一验证器覆盖工作树和真实 npm tarball：三候选根必须存在，gate-status
 * 与 help 必须逐字段一致，adapter 必须与权威脚本同源，当前文档不得保留
 * 失真的阶段声明。失败只输出稳定诊断码，不泄露本机路径。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const packMode = args.includes('--pack');
const tarballIndex = args.indexOf('--tarball');
const tarballArgument = tarballIndex >= 0 ? args[tarballIndex + 1] : null;
const sourceRoot = resolve(join(import.meta.dirname, '..'));
const checks = [];
const failures = [];
const cleanupRoots = [];

if (packMode && tarballArgument) recordFailure('ARGUMENT_CONFLICT');
if (tarballIndex >= 0 && !tarballArgument) recordFailure('TARBALL_ARGUMENT_REQUIRED');

let candidateRoot = sourceRoot;
try {
  if (packMode || tarballArgument) {
    candidateRoot = prepareTarballCandidate(packMode ? null : resolve(tarballArgument));
  }
  if (failures.length === 0) await verifyCandidate(candidateRoot);
} catch (error) {
  recordFailure(stableErrorCode(error));
} finally {
  for (const root of cleanupRoots.reverse()) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

emitResult();
process.exit(failures.length === 0 ? 0 : 1);

function prepareTarballCandidate(existingTarball) {
  const workspace = mkdtempSync(join(tmpdir(), 'e2e-truth-tarball-'));
  cleanupRoots.push(workspace);
  let tarball = existingTarball;
  if (!tarball) {
    let packed;
    try {
      packed = JSON.parse(execFileSync('npm', [
        'pack', '--json', '--pack-destination', workspace,
      ], {
        cwd: sourceRoot,
        encoding: 'utf8',
        timeout: 60000,
      }));
    } catch {
      throw new Error('PACK_FAILED');
    }
    const filename = (Array.isArray(packed) ? packed[0] : packed)?.filename;
    if (!filename) throw new Error('PACK_OUTPUT_INVALID');
    tarball = join(workspace, filename);
  }
  if (!existsSync(tarball)) throw new Error('TARBALL_UNAVAILABLE');
  try {
    execFileSync('tar', ['xzf', tarball, '-C', workspace], { timeout: 30000 });
  } catch {
    throw new Error('TARBALL_EXTRACT_FAILED');
  }
  const unpacked = join(workspace, 'package');
  if (!existsSync(join(unpacked, 'package.json'))) throw new Error('TARBALL_LAYOUT_INVALID');

  // 只安装包自身依赖；可选 peer 由后续真实采用拓扑门验证。
  try {
    execFileSync('npm', [
      'install', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund', '--no-package-lock',
    ], {
      cwd: unpacked,
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch {
    throw new Error('TARBALL_DEPENDENCY_INSTALL_FAILED');
  }
  return unpacked;
}

async function verifyCandidate(root) {
  const roots = {
    root,
    codex: join(root, 'adapters', 'codex'),
    claude: join(root, 'adapters', 'claude'),
  };

  for (const [name, candidate] of Object.entries(roots)) {
    if (!existsSync(join(candidate, 'scripts', 'gate-status.mjs')) ||
        !existsSync(join(candidate, 'scripts', 'service-runner.mjs'))) {
      recordFailure(`CANDIDATE_${name.toUpperCase()}_MISSING`);
    }
  }
  if (failures.length > 0) return;

  verifyAdapterSourceConsistency(roots);
  verifyCurrentDocumentation(root);

  for (const [name, candidate] of Object.entries(roots)) {
    await verifyCandidateRoot(name, candidate);
  }
}

async function verifyCandidateRoot(name, root) {
  const gate = runJson(process.execPath, [join(root, 'scripts', 'gate-status.mjs'), '--json'], root,
    `GATE_${name.toUpperCase()}_FAILED`);
  if (!gate) return;

  const requestRoot = mkdtempSync(join(tmpdir(), `e2e-truth-${name}-`));
  cleanupRoots.push(requestRoot);
  const requestPath = join(requestRoot, 'request.json');
  writeFileSync(requestPath, `${JSON.stringify({ service: 'help' })}\n`);
  const help = runJson(process.execPath, [
    join(root, 'scripts', 'service-runner.mjs'), '--request', requestPath, '--json',
  ], root, `HELP_${name.toUpperCase()}_FAILED`);
  if (!help) return;

  const kernel = runKernel(root, `KERNEL_${name.toUpperCase()}_FAILED`);
  if (!kernel) return;
  const expectedProvider = kernel.providerInstallation.status === 'consistent' ? 'PROVEN' : 'NOT_PROVEN';
  const expectedConformance = kernel.conformance.status === 'pass' ? 'PASS' : 'FAIL';
  const expectedQualification = kernel.qualification.status === 'qualified'
    ? 'QUALIFIED'
    : 'NOT_QUALIFIED';
  const expectedMethodForward = kernel.qualifications?.methodForward?.status ?? 'NOT_STARTED';
  const expectedTrust = expectedProvider === 'PROVEN' &&
    expectedConformance === 'PASS' && expectedQualification === 'QUALIFIED'
    ? 'PROVEN'
    : 'NOT_PROVEN';

  const exact =
    gate.gatePassed === (
      expectedProvider === 'PROVEN' &&
      expectedConformance === 'PASS' &&
      expectedQualification === 'QUALIFIED'
    ) &&
    gate.implementation?.descriptor === (expectedProvider === 'PROVEN' ? 'present' : 'inconsistent') &&
    gate.conformance?.deterministic === kernel.conformance.status &&
    gate.conformance?.behaviorQualification === kernel.qualification.status &&
    gate.conformance?.operationalQualification === kernel.qualifications?.operational?.status &&
    gate.conformance?.methodForwardQualification === expectedMethodForward &&
    JSON.stringify(gate.conformance?.methodForwardPendingMarkers || []) === JSON.stringify(kernel.qualifications?.methodForward?.pendingMarkers || []) &&
    gate.conformance?.releaseArtifactCertification === null &&
    help.status === 'AVAILABLE' &&
    help.code === 'HELP_READY' &&
    help.providerInstallation === expectedProvider &&
    help.conformance === expectedConformance &&
    help.qualification === expectedQualification &&
    help.qualifications?.operational === kernel.qualifications?.operational?.status &&
    help.qualifications?.methodForward === expectedMethodForward &&
    JSON.stringify(help.qualifications?.methodForwardPendingMarkers || []) === JSON.stringify(kernel.qualifications?.methodForward?.pendingMarkers || []) &&
    help.qualifications?.releaseArtifact === null &&
    help.trust === expectedTrust &&
    help.familyEnablement === 'NOT_ENABLED';

  if (exact) recordPass(`TRUTH_${name.toUpperCase()}_EXACT`);
  else recordFailure(`TRUTH_${name.toUpperCase()}_MISMATCH`);

  if (containsAbsolutePath(gate) || containsAbsolutePath(help) || containsAbsolutePath(kernel.diagnostics)) {
    recordFailure(`OUTPUT_${name.toUpperCase()}_PATH_LEAK`);
  } else {
    recordPass(`OUTPUT_${name.toUpperCase()}_PATH_SAFE`);
  }
}

function verifyAdapterSourceConsistency(roots) {
  const authoritative = [
    'scripts/gate-status.mjs',
    'scripts/service-runner.mjs',
    'scripts/verify-truthfulness.mjs',
    'scripts/lib/truthfulness-kernel.mjs',
    'scripts/lib/behavior-qualification.mjs',
    'scripts/lib/method-forward-qualification.mjs',
    'scripts/lib/method-forward-trials.mjs',
  ];
  for (const relativePath of authoritative) {
    let source;
    try { source = readFileSync(join(roots.root, relativePath)); }
    catch { recordFailure('AUTHORITATIVE_SOURCE_MISSING'); continue; }
    for (const adapter of ['codex', 'claude']) {
      try {
        if (!source.equals(readFileSync(join(roots[adapter], relativePath)))) {
          recordFailure(`ADAPTER_${adapter.toUpperCase()}_SOURCE_DRIFT`);
        }
      } catch {
        recordFailure(`ADAPTER_${adapter.toUpperCase()}_SOURCE_MISSING`);
      }
    }
  }
  if (!failures.some(code => code.includes('ADAPTER_') || code === 'AUTHORITATIVE_SOURCE_MISSING')) {
    recordPass('ADAPTER_SOURCE_CONSISTENT');
  }
}

function verifyCurrentDocumentation(root) {
  const patterns = [
    /(?:当前|current)[^\n]{0,80}\bGate\s*A\b/i,
    /(?:当前|current)[^\n]{0,80}\bNOT_IMPLEMENTED\b/i,
    /(?:当前|current)[^\n]{0,80}\bNOT_QUALIFIED\b/i,
  ];
  for (const file of ['README.md', 'README.zh-CN.md', 'INSTALL.md', 'AGENTS.md']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if (patterns.some(pattern => pattern.test(content))) {
      recordFailure(`DOCUMENT_${file.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase()}_STALE`);
    }
  }
  if (!failures.some(code => code.startsWith('DOCUMENT_'))) recordPass('DOCUMENT_CURRENT_STATE_CONSISTENT');
}

function runJson(command, commandArgs, cwd, failureCode) {
  try {
    return JSON.parse(execFileSync(command, commandArgs, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
    }));
  } catch {
    recordFailure(failureCode);
    return null;
  }
}

function runKernel(root, failureCode) {
  const kernelUrl = pathToFileURL(join(root, 'scripts', 'lib', 'truthfulness-kernel.mjs')).href;
  const program = [
    `import { createTruthKernel } from ${JSON.stringify(kernelUrl)};`,
    `const result = await createTruthKernel(${JSON.stringify(root)}).verify();`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  return runJson(process.execPath, ['--input-type=module', '--eval', program], root, failureCode);
}

function containsAbsolutePath(value) {
  const text = JSON.stringify(value);
  return /(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\\\Users\\\\)/.test(text);
}

function stableErrorCode(error) {
  return String(error?.message ?? '').match(/^[A-Z][A-Z0-9_]+$/)?.[0] ?? 'TRUTHFULNESS_FAILED';
}

function recordPass(code) {
  if (!checks.some(check => check.code === code)) checks.push({ code, status: 'PASS' });
}

function recordFailure(code) {
  if (!failures.includes(code)) failures.push(code);
  if (!checks.some(check => check.code === code)) checks.push({ code, status: 'FAIL' });
}

function emitResult() {
  const result = {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    diagnostics: failures.map(code => ({ code, severity: 'error' })),
  };
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const check of checks) {
    process.stdout.write(`${check.status === 'PASS' ? '✓' : '✗'} ${check.code}\n`);
  }
  process.stdout.write(`Truthfulness: ${result.status}\n`);
}
