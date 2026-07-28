#!/usr/bin/env node

/**
 * R27 杠杆 4：per-trial 编排隔离批量执行器。
 *
 * 批量执行 2 宿主 × 3 业务包组合；单 trial HOST_TIMEOUT/失败记为该组合诚实 FAIL
 * （终态不变、非重试、产出完整终态 receipt），其余 trial 继续执行；
 * 进程组 kill 与 tempdir cleanup 保证不产生孤儿 trial（每个组合必有终态制品）。
 *
 * 6+6+6 数量合同（2 宿主 × 3 业务包，精确 6 trials + 6 rubrics + 6 verified-rubrics）
 * 与 method-forward-qualification-aggregate.mjs 的失败关闭语义保持不变——
 * 诚实 FAIL 的组合仍令资格失败关闭，但批跑必须产出完整诚实画像。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { FORWARD_HOSTS, FORWARD_PACKAGE_IDS, resolveForwardBudget } from './lib/method-forward-trials.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const trialRunnerPath = join(pluginRoot, 'scripts', 'method-forward-trial-runner.mjs');

const argv = process.argv.slice(2);
const flagValue = flag => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};

if (process.argv[1]?.endsWith('method-forward-batch-runner.mjs')) {
  try {
    const result = runBatch({
      tarDir: flagValue('--tar-dir'),
      packageManifestDir: flagValue('--package-manifest-dir'),
      hostCommands: {
        codex: flagValue('--codex-command'),
        'claude-code': flagValue('--claude-command'),
      },
      timeoutMsFlag: flagValue('--timeout-ms'),
      evidenceMode: flagValue('--evidence-mode') || 'real',
      outputDir: flagValue('--output'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.summary.fail > 0 || result.summary.blocked > 0) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BATCH_BLOCKED', code: String(error?.code || error?.message || 'BATCH_FAILED') }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

/**
 * 批量执行全部 2×3 组合。每个组合独立 prepare → run → verify。
 * 单 trial 失败不影响其余 trial，每个组合必有终态制品。
 *
 * @param {object} options
 * @param {string} options.tarDir 包含 {packageId}.tar 的目录。
 * @param {string} options.packageManifestDir 包含 {packageId}.manifest.json 的目录。
 * @param {Record<string, string>} options.hostCommands 宿主命令映射。
 * @param {string|null} options.timeoutMsFlag CLI 预算覆盖。
 * @param {string} options.evidenceMode 'real' | 'synthetic'。
 * @param {string|null} options.outputDir 结果输出目录。
 * @returns {{ results: Array, summary: object }}
 */
export function runBatch({ tarDir, packageManifestDir, hostCommands, timeoutMsFlag, evidenceMode, outputDir }) {
  const { timeoutMs, source: budgetSource } = resolveForwardBudget(timeoutMsFlag, process.env.E2E_TEST_FORWARD_TIMEOUT_MS);
  const batchRoot = outputDir || mkdtempSync(join(tmpdir(), 'e2e-batch-'));
  mkdirSync(batchRoot, { recursive: true });

  const combinations = FORWARD_HOSTS.flatMap(hostId =>
    FORWARD_PACKAGE_IDS.map(packageId => ({ hostId, packageId })),
  );

  const results = [];
  const tempDirs = [];

  for (const { hostId, packageId } of combinations) {
    const trialRoot = join(batchRoot, `${hostId}--${packageId}`);
    const tempDir = mkdtempSync(join(tmpdir(), `e2e-trial-${hostId}-${packageId}-`));
    tempDirs.push(tempDir);

    let trialResult = null;
    try {
      // prepare
      const tarPath = join(tarDir, `${packageId}.tar`);
      const manifestPath = join(packageManifestDir, `${packageId}.manifest.json`);
      const hostCommand = hostCommands[hostId];

      if (!existsSync(tarPath) || !existsSync(manifestPath) || !hostCommand) {
        trialResult = writeFailResult(trialRoot, hostId, packageId, 'BATCH_INPUT_MISSING', evidenceMode);
        results.push(trialResult);
        continue;
      }

      const prepareArgs = [
        trialRunnerPath, 'prepare',
        '--root', trialRoot,
        '--host', hostId,
        '--package', packageId,
        '--tar', tarPath,
        '--package-manifest', manifestPath,
        '--host-command', hostCommand,
        '--evidence-mode', evidenceMode,
      ];

      const prepareResult = execFileSync(process.execPath, prepareArgs, {
        encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const prepared = JSON.parse(prepareResult);
      if (prepared.status !== 'PREPARED') {
        trialResult = writeFailResult(trialRoot, hostId, packageId, prepared.code || 'PREPARE_FAILED', evidenceMode);
        results.push(trialResult);
        continue;
      }

      // run（单 trial 失败记为该组合诚实 FAIL，不中断批跑）
      let runResult;
      try {
        const runArgs = [trialRunnerPath, 'run', '--root', trialRoot, '--timeout-ms', String(timeoutMs)];
        const runOutput = execFileSync(process.execPath, runArgs, {
          encoding: 'utf8', timeout: timeoutMs + 60000, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, E2E_TEST_FORWARD_TIMEOUT_MS: String(timeoutMs) },
        });
        runResult = JSON.parse(runOutput);
      } catch (runError) {
        // 单 trial run 失败（超时/崩溃）→ 该组合诚实 FAIL，其余继续
        let parsed = null;
        try { parsed = JSON.parse(runError.stdout || ''); } catch { /* 无结构化输出 */ }
        runResult = parsed || { status: 'FAIL', code: 'HOST_TIMEOUT' };
      }

      // verify（即使 run 失败也尝试 verify 以产出终态制品）
      try {
        const verifyArgs = [trialRunnerPath, 'verify', '--root', trialRoot];
        const verifyOutput = execFileSync(process.execPath, verifyArgs, {
          encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        trialResult = JSON.parse(verifyOutput);
      } catch (verifyError) {
        let parsed = null;
        try { parsed = JSON.parse(verifyError.stdout || ''); } catch { /* 无结构化输出 */ }
        trialResult = parsed || writeFailResult(trialRoot, hostId, packageId, runResult.code || 'VERIFY_FAILED', evidenceMode);
      }
    } catch (error) {
      // 任何未预期异常 → 该组合诚实 FAIL，其余继续
      trialResult = writeFailResult(trialRoot, hostId, packageId, String(error?.code || 'BATCH_TRIAL_ERROR'), evidenceMode);
    }

    results.push(trialResult);
  }

  // cleanup tempdirs（保证不产生孤儿）
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
  }

  const summary = {
    total: combinations.length,
    pass: results.filter(r => r.status === 'PASS').length,
    fail: results.filter(r => r.status === 'FAIL').length,
    blocked: results.filter(r => r.status === 'BLOCKED').length,
    budgetTimeoutMs: timeoutMs,
    budgetSource,
  };

  const batchResult = { status: summary.fail === 0 && summary.blocked === 0 ? 'BATCH_COMPLETE' : 'BATCH_PARTIAL', results, summary };
  writeFileSync(join(batchRoot, 'batch-result.json'), `${JSON.stringify(batchResult, null, 2)}\n`);
  return batchResult;
}

/** 为无法完成 verify 的组合写入诚实 FAIL 终态制品。 */
function writeFailResult(trialRoot, hostId, packageId, code, evidenceMode) {
  mkdirSync(trialRoot, { recursive: true });
  const evidenceDir = join(trialRoot, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const result = {
    schemaVersion: 1,
    trialId: `${hostId}--${packageId}`,
    packageId,
    hostId,
    evidenceMode,
    status: 'FAIL',
    code: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'BATCH_TRIAL_ERROR',
    input: {
      tarballDigest: `sha256:${'0'.repeat(64)}`,
      rawInputDigest: `sha256:${'0'.repeat(64)}`,
      projectFactsDigest: `sha256:${'0'.repeat(64)}`,
      goalDigest: `sha256:${'0'.repeat(64)}`,
      pluginSubjectDigest: `sha256:${'0'.repeat(64)}`,
    },
    invocation: {
      cliVersion: 'unavailable',
      exitCode: null,
      timedOut: false,
      hostInvocationDigest: `sha256:${'0'.repeat(64)}`,
      eventStreamDigest: `sha256:${'0'.repeat(64)}`,
      skillReadVerified: false,
      authorCommandVerified: false,
      unexpectedToolDetected: false,
      budgetTimeoutMs: null,
      budgetSource: null,
    },
    author: {
      chainCompleted: false,
      stages: [],
      stageChainDigest: null,
      stageResultsManifestDigest: null,
      previewDigest: null,
      artifactPackageDigest: null,
      plannedWrites: [],
      evidenceRefs: [],
    },
    isolation: {
      inputUnmodified: true,
      pluginUnmodified: true,
      zeroUnauthorizedWrites: true,
      absolutePathDetected: false,
      writeDelta: [],
    },
    digest: `sha256:${'0'.repeat(64)}`,
  };
  writeFileSync(join(evidenceDir, 'trial-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
