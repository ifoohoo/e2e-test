/**
 * precondition-diagnostics.mjs
 *
 * 三个外部 root 环境前置条件的显式诊断（CR-S3-PRECOND-ISOLATION）。
 *
 * conformance 与行为资格依赖三个外部 root：agent-method-registry、artifact-graph、
 * artifact-chain-assistant。环境缺失时入口必须显式报告每个 root 的解析来源与状态
 * （missing-env / not-absolute / inaccessible / cli-missing / present），不得通过
 * "缺环境默认跳过"制造假 PASS，也不得使用默认路径回退掩盖缺失。
 *
 * 诊断结果为结构化矩阵，可被 gate-status 等门禁消费，用于区分
 * "通过 / 诚实阻断（外部前置缺失）/ 失败"。
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const EXTERNAL_ROOT_SPECS = Object.freeze([
  Object.freeze({
    root: 'agent-method-registry',
    envVar: 'E2E_TEST_REGISTRY_ROOT',
    resolutionSource: 'env:E2E_TEST_REGISTRY_ROOT 或已安装 agent-method-registry 包（import.meta.resolve）',
    cliSubpath: 'dist/bin.js',
  }),
  Object.freeze({
    root: 'artifact-graph',
    envVar: 'E2E_TEST_ARTIFACT_GRAPH_ROOT',
    resolutionSource: 'env:E2E_TEST_ARTIFACT_GRAPH_ROOT',
    cliSubpath: 'packages/artifact-graph/dist/cli.js',
  }),
  Object.freeze({
    root: 'artifact-chain-assistant',
    envVar: 'E2E_TEST_ASSISTANT_ROOT',
    resolutionSource: 'env:E2E_TEST_ASSISTANT_ROOT',
    cliSubpath: 'scripts/family-compile.mjs',
  }),
]);

/**
 * 诊断三个外部 root 前置条件。
 *
 * @param {Object} options
 * @param {NodeJS.ProcessEnv} [options.env] - 环境变量（默认 process.env）
 * @param {Object<string,string|null>} [options.resolvedPaths] -
 *   调用方已通过其他来源（如已安装包解析）得到的 root 路径；仅在环境变量未设置时使用。
 *   不接受默认路径猜测：无来源即 missing-env。
 * @returns {{ schemaVersion: number, timestamp: string|null, roots: Array<Object>, allPresent: boolean }}
 */
export function diagnoseExternalRoots({ env = process.env, resolvedPaths = {}, timestamp = null } = {}) {
  const roots = EXTERNAL_ROOT_SPECS.map(spec => {
    const entry = {
      root: spec.root,
      envVar: spec.envVar,
      resolutionSource: spec.resolutionSource,
      path: null,
      cliPath: null,
      status: 'missing-env',
      detail: `${spec.envVar} 未设置且无已解析安装来源；无默认路径回退，不得跳过`,
    };
    const fromEnv = env[spec.envVar] ? String(env[spec.envVar]).trim() : null;
    const fromResolved = resolvedPaths[spec.root] || null;
    const path = fromEnv || fromResolved;
    if (!path) return entry;
    entry.path = path;
    if (fromResolved && !fromEnv) entry.resolutionSource = `已安装 ${spec.root} 包解析（import.meta.resolve）`;
    if (!isAbsolute(path)) {
      entry.status = 'not-absolute';
      entry.detail = `${path} 不是绝对路径；拒绝相对路径猜测`;
      return entry;
    }
    try {
      accessSync(path, fsConstants.R_OK);
    } catch {
      entry.status = 'inaccessible';
      entry.detail = `${path} 不存在或不可读`;
      return entry;
    }
    const cliPath = join(path, spec.cliSubpath);
    try {
      accessSync(cliPath, fsConstants.R_OK);
    } catch {
      entry.status = 'cli-missing';
      entry.cliPath = cliPath;
      entry.detail = `root 可访问但 CLI ${cliPath} 不可读（未构建或路径不匹配）`;
      return entry;
    }
    entry.status = 'present';
    entry.cliPath = cliPath;
    entry.detail = 'root 与 CLI 均可读';
    return entry;
  });
  return {
    schemaVersion: 1,
    timestamp,
    roots,
    allPresent: roots.every(item => item.status === 'present'),
  };
}

/**
 * 解析 conformance attestation 输出目录。
 *
 * 默认 <pluginRoot>/conformance；可通过 E2E_TEST_CONFORMANCE_DIR 绑定到每测试/run
 * 独立的隔离目录（必须是已验证的绝对路径）。相对路径失败关闭，避免并行 run
 * 通过共享目录互相污染。
 *
 * @throws {{ code: 'CONFORMANCE_DIR_INVALID' }} 当 override 非绝对路径
 */
export function resolveConformanceDir({ env = process.env, pluginRoot }) {
  const override = env.E2E_TEST_CONFORMANCE_DIR ? String(env.E2E_TEST_CONFORMANCE_DIR).trim() : null;
  if (!override) return join(pluginRoot, 'conformance');
  if (!isAbsolute(override)) {
    throw Object.assign(new Error('CONFORMANCE_DIR_INVALID'), { code: 'CONFORMANCE_DIR_INVALID' });
  }
  return override;
}
