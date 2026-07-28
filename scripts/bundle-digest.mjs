#!/usr/bin/env node

/**
 * Registry 权威 bundle observation facade。
 *
 * 本脚本不实现 bundle 遍历、symlink 或摘要算法；它只构造最小的 v2
 * provider observation 请求，并从 agent-method-registry 公共
 * verifyProvider().observed.bundleDigest 读取结果。
 *
 * 双模式（R6）：
 *   默认模式：只在 Registry status=verified 且 observed digest 等于 descriptor 时 exit 0；否则 exit nonzero。
 *   --observe：显式 maintainer 模式，允许 mismatch 时返回 observed digest，
 *              但必须输出真实 verificationStatus，不能被 conformance 当作 PASS。
 *
 * 从 agent-method-registry 包导入（不再依赖源码旁路）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Support override for computing bundle digest of adapter roots
const pluginRoot = process.env.E2E_TEST_PLUGIN_ROOT || join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const observeMode = args.includes('--observe');

let verifyProvider;
try {
  ({ verifyProvider } = await import('agent-method-registry'));
} catch {
  const msg = 'Cannot import agent-method-registry package';
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, code: 'REGISTRY_IMPORT_FAILED', status: 'FAILED', message: msg }));
  } else {
    console.error(`ERROR: ${msg}`);
  }
  process.exit(1);
}

const implementationPath = join(pluginRoot, 'family', 'implementation.yaml');
const implementationText = readFileSync(implementationPath, 'utf8');

function scalar(name) {
  const match = implementationText.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
}

function nestedScalar(section, name) {
  const sectionMatch = implementationText.match(new RegExp(`^${section}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, 'm'));
  const match = sectionMatch?.[1].match(new RegExp(`^[ \\t]+${name}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`Missing ${section}.${name}`);
  return match[1].trim();
}

function bundleRoots() {
  const bundleMatch = implementationText.match(/^bundle:\s*\n((?:[ \t]+.*\n?)*)/m);
  const rootsMatch = bundleMatch?.[1].match(/^[ \t]+roots:\s*\n((?:[ \t]+- .*\n?)*)/m);
  const roots = rootsMatch?.[1]
    .split('\n')
    .map(line => line.match(/^[ \t]+-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean) ?? [];
  if (roots.length === 0) throw new Error('Missing bundle.roots');
  return roots;
}

let descriptor;
try {
  const pluginId = scalar('pluginId');
  const version = scalar('version');
  const treeDigest = nestedScalar('bundle', 'treeDigest');
  descriptor = { pluginId, version, treeDigest, roots: bundleRoots() };
} catch (error) {
  const msg = 'Cannot parse implementation.yaml';
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, code: 'DESCRIPTOR_PARSE_FAILED', status: 'FAILED', message: msg }));
  } else {
    console.error(`ERROR: ${msg}`);
  }
  process.exit(1);
}

const placeholderDigest = `sha256:${'0'.repeat(64)}`;
const inventoryEntry = {
  pluginId: descriptor.pluginId,
  canonicalRoot: pluginRoot,
  version: descriptor.version,
  packageDigest: placeholderDigest,
  provenance: 'local-conformance',
  host: 'codex',
};

const result = verifyProvider({
  host: 'codex',
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
      host: 'codex',
      canonicalRoot: pluginRoot,
      skillPath: 'skills/e2e-test-help',
      packageDigest: placeholderDigest,
      bundleDigest: descriptor.treeDigest,
      provenance: 'local-conformance',
    },
    inventorySnapshot: { digest: placeholderDigest, freshness: 'fresh' },
  },
});

const observedDigest = result.observed?.bundleDigest;
const registryStatus = result.status;
const descriptorMatch = observedDigest === descriptor.treeDigest;

if (observeMode) {
  // Maintainer observation mode: always returns observed digest, reports real status
  const output = {
    ok: true,
    code: 'OBSERVED',
    status: registryStatus,
    verificationStatus: registryStatus,
    digest: observedDigest || null,
    match: descriptorMatch,
    roots: descriptor.roots,
    authority: 'agent-method-registry.verifyProvider.observed.bundleDigest',
    diagnostics: (result.diagnostics || []).map(d => ({ code: d.code, severity: d.severity })),
  };
  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Digest: ${output.digest}`);
    console.log(`Status: ${output.verificationStatus}`);
    console.log(`Match: ${output.match}`);
  }
  // Exit nonzero if registry itself failed (not just mismatch)
  process.exit(registryStatus === 'verified' ? 0 : 1);
} else {
  // Default mode: only exit 0 when registry verified AND digest matches descriptor
  if (!observedDigest) {
    const output = {
      ok: false, code: 'OBSERVATION_FAILED', status: 'FAILED',
      message: 'Registry did not return observed.bundleDigest',
      diagnostics: (result.diagnostics || []).map(d => ({ code: d.code, severity: d.severity })),
    };
    if (jsonMode) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`ERROR: ${output.message}`);
    }
    process.exit(1);
  }

  if (registryStatus !== 'verified' || !descriptorMatch) {
    const output = {
      ok: false,
      code: descriptorMatch ? 'REGISTRY_NOT_VERIFIED' : 'DIGEST_MISMATCH',
      status: 'REJECTED',
      digest: observedDigest,
      verificationStatus: registryStatus,
      roots: descriptor.roots,
      authority: 'agent-method-registry.verifyProvider.observed.bundleDigest',
      diagnostics: (result.diagnostics || []).map(d => ({ code: d.code, severity: d.severity })),
    };
    if (jsonMode) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`Digest mismatch: observed=${observedDigest}, status=${registryStatus}`);
    }
    process.exit(1);
  }

  const output = {
    ok: true,
    code: 'VERIFIED',
    status: 'VERIFIED',
    verificationStatus: registryStatus,
    digest: observedDigest,
    roots: descriptor.roots,
    authority: 'agent-method-registry.verifyProvider.observed.bundleDigest',
    diagnostics: [],
  };
  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Digest: ${observedDigest}`);
    console.log(`Status: ${registryStatus}`);
  }
  process.exit(0);
}
