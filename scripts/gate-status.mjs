#!/usr/bin/env node

/**
 * gate-status.mjs
 *
 * 输出 E2E 测试技能族的 Gate A 状态（机器可读 JSON）。
 *
 * 用法:
 *   node scripts/gate-status.mjs [--json]
 *   node scripts/gate-status.mjs --service <help|default|author|review|repair> [--json]
 *
 * --service help   : 退出 0，输出完整 Gate 状态
 * --service 其他   : 退出非零，输出 fail-closed/not-implemented 结构化状态
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const serviceIdx = args.indexOf('--service');
const service = serviceIdx !== -1 ? args[serviceIdx + 1] : null;

// 读取 package.json 获取版本
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// 检查 implementation descriptor
let implStatus = 'missing';
try {
  statSync(join(pluginRoot, 'family', 'implementation.yaml'));
  implStatus = 'present';
} catch {
  // missing
}

// 检查技能
const skills = ['e2e-test-help', 'e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'];
const skillStatus = {};
for (const skill of skills) {
  try {
    statSync(join(pluginRoot, 'skills', skill, 'SKILL.md'));
    skillStatus[skill] = 'present';
  } catch {
    skillStatus[skill] = 'missing';
  }
}

// 检查 adapter
const adapters = { codex: 'missing', claude: 'missing' };
for (const host of ['codex', 'claude']) {
  try {
    statSync(join(pluginRoot, 'adapters', host, 'skills', 'e2e-test-help', 'SKILL.md'));
    adapters[host] = 'present';
  } catch {
    // missing
  }
}

// --service 模式：输出特定服务的 fail-closed 状态
const serviceResponses = {
  help: {
    service: 'help',
    status: 'available',
    behavior: 'read-only-diagnostic',
  },
  default: {
    service: 'default',
    status: 'fail-closed',
    reason: 'GATE_B_REQUIRED',
    message: '当前 e2e-test 技能族处于 Gate A（独立仓库骨架）。默认入口尚未实现。author/review/repair 均为 fail-closed placeholder。',
  },
  author: {
    service: 'author',
    status: 'not-implemented',
    reason: 'NOT_IMPLEMENTED',
    message: 'e2e-test-author 尚未实现。此服务的目标行为：接受 artifact.context-packet@1 和 user.requirement@1，产出 artifact.e2e-test@1 制品。当前 Gate A 状态下不提供此能力。',
  },
  review: {
    service: 'review',
    status: 'not-implemented',
    reason: 'NOT_IMPLEMENTED',
    message: 'e2e-test-review 尚未实现。此服务的目标行为：接受 artifact.e2e-test@1，产出 artifact.review-result@1。副作用上限: read-only, write-run-evidence。当前 Gate A 状态下不提供此能力。',
  },
  repair: {
    service: 'repair',
    status: 'not-implemented',
    reason: 'NOT_IMPLEMENTED',
    message: 'e2e-test-repair 尚未实现。此服务的目标行为：接受 artifact.e2e-test@1 和 artifact.review-result@1，产出修复后的 artifact.e2e-test@1 和 artifact.review-result@1。当前 Gate A 状态下不提供此能力。',
  },
};

if (service) {
  if (!serviceResponses[service]) {
    console.error(`Unknown service: ${service}. Valid: help, default, author, review, repair`);
    process.exit(1);
  }

  const response = serviceResponses[service];
  if (jsonMode) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log(`Service: ${response.service}`);
    console.log(`Status: ${response.status}`);
    if (response.reason) console.log(`Reason: ${response.reason}`);
    if (response.message) console.log(`Message: ${response.message}`);
  }

  // help 退出 0，其他退出非零
  if (service !== 'help') {
    process.exit(1);
  }
  process.exit(0);
}

// 默认模式：输出完整 Gate 状态
const status = {
  version: pkg.version,
  gate: 'A',
  gatePassed: Object.values(skillStatus).every(s => s === 'present'),
  implementation: {
    descriptor: implStatus,
    path: 'family/implementation.yaml',
  },
  skills: skillStatus,
  adapters,
  services: {
    'e2e-test-help': { status: 'available', behavior: 'read-only-diagnostic' },
    'e2e-test': { status: 'fail-closed', behavior: 'GATE_B_REQUIRED' },
    'e2e-test-author': { status: 'not-implemented', behavior: 'NOT_IMPLEMENTED' },
    'e2e-test-review': { status: 'not-implemented', behavior: 'NOT_IMPLEMENTED' },
    'e2e-test-repair': { status: 'not-implemented', behavior: 'NOT_IMPLEMENTED' },
  },
  providerCatalog: { emitted: false },
  defaultEnabled: false,
  registry: { bound: false },
  contracts: {
    artifact: { id: 'artifact.e2e-test@1', status: 'draft' },
    familyApi: { id: 'artifact.e2e-test-family@1', status: 'draft' },
  },
  conformance: {
    deterministic: 'not-run',
    behaviorQualification: 'not-run',
  },
};

if (jsonMode) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`E2E Test Skill Family v${status.version} (Gate ${status.gate})`);
  console.log(`Gate A Passed: ${status.gatePassed}`);
  console.log();
  console.log('Skills:');
  for (const [name, s] of Object.entries(status.skills)) {
    console.log(`  ${name}: ${s}`);
  }
  console.log();
  console.log('Services:');
  for (const [name, svc] of Object.entries(status.services)) {
    console.log(`  ${name}: ${svc.status} (${svc.behavior})`);
  }
  console.log();
  console.log(`Provider Catalog: ${status.providerCatalog.emitted ? 'emitted' : 'not emitted'}`);
  console.log(`Default Enabled: ${status.defaultEnabled}`);
  console.log(`Registry Bound: ${status.registry.bound}`);
}
