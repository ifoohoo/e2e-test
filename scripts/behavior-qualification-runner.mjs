#!/usr/bin/env node

/**
 * behavior-qualification-runner.mjs
 *
 * 双宿主行为资格验证入口。
 * 调用 behavior-qualification-harness.mjs 执行真实行为资格测试。
 *
 * 用法:
 *   node scripts/behavior-qualification-runner.mjs [--json] [--finalize]
 *
 * 环境变量:
 *   E2E_TEST_REGISTRY_ROOT        — agent-method-registry 根目录
 *   E2E_TEST_ARTIFACT_GRAPH_ROOT  — artifact-graph 根目录
 *   E2E_TEST_ASSISTANT_ROOT       — artifact-chain-assistant 根目录
 */

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diagnoseExternalRoots } from './lib/precondition-diagnostics.mjs';

const pluginRoot = join(import.meta.dirname, '..');
const jsonMode = process.argv.includes('--json');
const finalizeMode = process.argv.includes('--finalize');

// 三个外部 root 前置条件显式诊断：缺失时显式报告每个 root 的解析来源与状态，
// 不得通过缺环境默认跳过制造假 QUALIFIED。
const preconditions = diagnoseExternalRoots({ env: process.env });
if (!preconditions.allPresent) {
  const missing = preconditions.roots.filter(item => item.status !== 'present');
  const msg = `Error: external root preconditions not satisfied: ${missing.map(item => `${item.root}=${item.status} (${item.resolutionSource})`).join('; ')}`;
  if (jsonMode) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      qualificationStatus: 'BLOCKED',
      hosts: { codex: null, claude: null },
      trials: [],
      digest: null,
      message: msg,
      preconditions,
    }, null, 2));
  } else {
    console.error(msg);
    for (const item of preconditions.roots) {
      console.error(`  ${item.status === 'present' ? '✓' : '⊘'} ${item.root}: ${item.status} [${item.resolutionSource}]${item.path ? ` path=${item.path}` : ''} (${item.detail})`);
    }
  }
  process.exit(1);
}

// 调用 harness
const harnessPath = join(pluginRoot, 'scripts', 'behavior-qualification-harness.mjs');
const args = [];
if (jsonMode) args.push('--json');
if (finalizeMode) args.push('--finalize');

try {
  const output = execFileSync(process.execPath, [harnessPath, ...args], {
    encoding: 'utf8',
    timeout: 900000, // 两个宿主各最多 6 分钟，并为 pack/install 留出余量
    cwd: pluginRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  console.log(output);
} catch (err) {
  // Harness 退出非零
  if (err.stdout) {
    console.log(err.stdout);
  }
  if (err.stderr && !jsonMode) {
    console.error(err.stderr);
  }
  process.exit(err.status || 1);
}
