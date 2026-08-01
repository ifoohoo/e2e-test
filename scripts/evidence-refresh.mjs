#!/usr/bin/env node
/**
 * 证据刷新（测试分层与发布门，方案 B；R28 模块加载兜底完备化）：
 * - 顶层兜底（R27 F-01 + R28 F-01）：完整入口（内部模块动态加载、
 *   digest 观察、descriptor 读取、一致性判定、标记读取、门禁判定、
 *   事务体）包在顶层 try/catch 中；任何未被内层处理的非结构化异常
 *   一律尽力写标记（step: unstructured-<位置>，含 unstructured-
 *   import）后非零退出 + 明细。
 * - 失败标记：pluginRoot 级 `.evidence-refresh-failed`（JSON，含
 *   step/reason/timestamp）。任何失败路径（env roots 前置、各步骤
 *   FAIL_CLOSED、回滚写入本身失败、非结构化异常）都尽力写标记；
 *   仅完整成功（全部步骤 + 复算一致）才清除标记。标记写不了时
 *   仍 fail-closed 非零退出并尽力输出明细（该边界无更强手段）。
 * - SKIP（加深判定 + R32 三根闭包 + 资格主体闭包）：第一条件 = 标记
 *   存在则永不 SKIP，并在入口输出如实携带前次失败明细；此外要求 root
 *   bundle-digest 观察值 === descriptor bundle.treeDigest，且 root、
 *   Codex adapter、Claude adapter 三个 canonical root 各自的
 *   conformance/last-run.json 三重一致（bundleDigest === treeDigest、
 *   attestation.digest === deterministicAttestation、status === PASS）、
 *   behavior-qualification.json 一致（存在可解析、QUALIFIED、
 *   evidence.bundleDigest === treeDigest、evidence.deterministicAttestation
 *   === deterministicAttestation），以及资格主体一致（每个 canonical
 *   root 的 buildQualificationSubject(rootDir) 的 algorithm+digest 与
 *   bq.evidence.qualificationSubjects[rootLabel] 精确匹配）；任一不满足
 *   → 进入刷新路径。
 * - 刷新路径（实际执行顺序，鸡生蛋原因见步骤 1）：
 *   1. 对齐 treeDigest 到 Registry 观察值——conformance 的全部 SPI
 *      检查以 descriptor treeDigest 为信任基线，陈旧时级联 REJECTED，
 *      runner 在陈旧基线下不可能 PASS，必须先对齐；
 *   2. conformance-runner --finalize-attestation（刷新 last-run.json 与
 *      descriptor deterministicAttestation；descriptor 在 bundle roots
 *      之外，不递归改变 treeDigest）；
 *   3. pnpm build（同步 adapters，harness 内部 build --check 才能通过）；
 *   4. Codex/Claude adapter conformance-runner --finalize-attestation
 *      （每个 adapter 是独立 canonical root，其 conformance 证据必须
 *      经自己的 runner 合法刷新）；
 *   5. behavior-qualification-harness --finalize（三个 canonical root
 *      一致写入 behavior-qualification.json）；
 *   6. 复算确认 root bundle 观察值与 treeDigest 一致，且三个
 *      canonical root 各自证据一致。
 * - 失败回滚：对齐前备份原 treeDigest；步骤 1-5 任何失败 → 恢复原值
 *   + 写失败标记 + FAIL_CLOSED（exit 1，明细含失败步骤）；回滚写入
 *   本身失败时明细含 rollbackError，标记成为下次不 SKIP 的防线
 *   （此时 treeDigest 可能保留新值，三重一致性可能全过）。
 * - 缺少必需的 E2E_TEST_REGISTRY_ROOT/E2E_TEST_ARTIFACT_GRAPH_ROOT/
 *   E2E_TEST_ASSISTANT_ROOT 时 fail-closed 清晰报错。
 * 永不手工改写 conformance/last-run.json（手工改写即伪造证据）。
 *
 * import 取舍（R28 F-01）：
 * - node:child_process/node:fs/node:path 保留静态 import——内建模块
 *   编译进运行时，无文件系统加载面；且失败标记写入本身依赖 fs，
 *   内建不可加载时任何兜底（含写标记）都不可能执行。
 * - ./lib/precondition-diagnostics.mjs（本仓库内部相对模块，有真实
 *   文件系统加载面）改为 main() 受保护入口内动态 import；加载失败
 *   走 UNSTRUCTURED_ENTRY_FAILURE（step: unstructured-import）+
 *   尽力写标记。
 * - 无第三方 import；agent-method-registry 仅由子进程
 *   bundle-digest 使用，其失败已被 observeDigest 的 error.stdout
 *   透传 / BUNDLE_DIGEST_OBSERVE_FAILED 路径覆盖。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');
const repoRoot = join(pluginRoot, '..', '..');
const descriptorPath = join(pluginRoot, 'family', 'implementation.yaml');
const markerPath = join(pluginRoot, '.evidence-refresh-failed');
// 内部相对模块（R28 F-01）：main() 的 import 阶段动态加载后赋值；
// 赋值前任何调用路径都不会触达（evidenceConsistency 在 observe/
// declared 之后才执行）
let resolveConformanceDir = null;
let buildQualificationSubject = null;
const REQUIRED_ENV = [
  'E2E_TEST_REGISTRY_ROOT',
  'E2E_TEST_ARTIFACT_GRAPH_ROOT',
  'E2E_TEST_ASSISTANT_ROOT',
];
const TREE_DIGEST_RE = /treeDigest:\s*sha256:[0-9a-f]{64}/;

/**
 * 失败标记（R26 F-01）：读取前次失败明细；标记损坏也视为存在
 * （不可解析的标记同样是失败信号，不得 SKIP）。
 */
function readMarker() {
  if (!existsSync(markerPath)) return null;
  try {
    return { marker: JSON.parse(readFileSync(markerPath, 'utf8')) };
  } catch (error) {
    return { marker: null, markerParseError: error.message };
  }
}

/**
 * 尽力写失败标记；标记本身写不了时返回错误信息（调用方仍须
 * fail-closed 非零退出并尽力输出明细——该边界无更强手段）。
 */
function writeMarker(details) {
  try {
    writeFileSync(markerPath, `${JSON.stringify({
      ...details,
      timestamp: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return error.message;
  }
}

/** 仅完整成功（全部步骤 + 复算一致）才允许清除标记 */
function clearMarker() {
  rmSync(markerPath, { force: true });
}

function fail(message, details = {}) {
  // 任何失败路径都尽力写失败标记（R26 F-01）；标记写不了时仍
  // fail-closed 非零退出，明细中尽力携带 markerWriteError
  const markerWriteError = writeMarker({ step: 'unknown', reason: message, ...details });
  process.stdout.write(`${JSON.stringify({
    status: 'FAIL_CLOSED',
    error: message,
    ...details,
    ...(markerWriteError ? { markerWriteError } : {}),
  }, null, 2)}\n`);
  process.exit(1);
}

function observeDigest(targetRoot = pluginRoot) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [
      join(pluginRoot, 'scripts', 'bundle-digest.mjs'),
      '--observe',
      '--json',
    ], {
      cwd: join(pluginRoot, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        // 绝对 pluginRoot：相对形式会把观测锚定到 packages/e2e-test 真身，
        // 绝对形式让本脚本在 package 副本上也可正确观测（事务负例）
        E2E_TEST_PLUGIN_ROOT: targetRoot,
      },
    });
  } catch (error) {
    // bundle-digest --observe 在 digest 失配时退出码为 1，但 stdout 仍
    // 携带机械观察 digest（既有刷新路径一直依赖该行为）
    if (error.stdout) {
      stdout = error.stdout;
    } else {
      fail('BUNDLE_DIGEST_OBSERVE_FAILED', {
        exitCode: error.status,
        stderr: error.stderr || '',
      });
    }
  }
  const digest = JSON.parse(stdout).digest;
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
    fail('BUNDLE_DIGEST_OBSERVE_FAILED', { stdout });
  }
  return digest;
}

function declaredTreeDigest() {
  const text = readFileSync(descriptorPath, 'utf8');
  const match = text.match(TREE_DIGEST_RE);
  if (!match) fail('TREE_DIGEST_NOT_FOUND_IN_DESCRIPTOR');
  return match[0].replace(/^treeDigest:\s*/, '');
}

function refreshTreeDigest(digest) {
  const text = readFileSync(descriptorPath, 'utf8');
  if (!TREE_DIGEST_RE.test(text)) fail('TREE_DIGEST_NOT_FOUND_IN_DESCRIPTOR');
  writeFileSync(
    descriptorPath,
    text.replace(TREE_DIGEST_RE, `treeDigest: ${digest}`),
    'utf8',
  );
}

function runStep(name, command, args, env = process.env) {
  process.stdout.write(`${JSON.stringify({ step: name, status: 'START' })}\n`);
  try {
    const stdout = execFileSync(command, args, {
      cwd: pluginRoot,
      encoding: 'utf8',
      timeout: 900000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(`${JSON.stringify({ step: name, status: 'PASS' })}\n`);
    return stdout;
  } catch (error) {
    const stepError = new Error(`${name}_FAILED`);
    stepError.step = name;
    stepError.details = {
      exitCode: error.status,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
    throw stepError;
  }
}

/**
 * 单个 canonical root 的证据一致性核查。
 *
 * 与内核 verifyConformance/verifyQualification 的 localProof 同形：
 * last-run.json 三重（bundleDigest === treeDigest、
 * attestation.digest === deterministicAttestation、status === PASS），
 * 以及 behavior-qualification.json 四项（存在可解析、QUALIFIED、
 * root 使用 evidence.bundleDigest / deterministicAttestation；adapter
 * 使用 evidence.scenarioIdentities.<host> 的本地 bundle / attestation），
 * 以及资格主体一致（buildQualificationSubject(rootDir) 的
 * algorithm+digest 与 bq.evidence.qualificationSubjects[rootLabel]
 * 精确匹配）；任一不满足返回原因。
 */
function checkSingleRoot(
  rootDir,
  rootLabel,
  observedDigest,
  conformanceDirOverride = null,
  checkQualificationSubject = true,
) {
  const descPath = join(rootDir, 'family', 'implementation.yaml');
  let descriptorText;
  try {
    descriptorText = readFileSync(descPath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${rootLabel} descriptor 不可读: ${error.message}` };
  }
  const treeDigest = descriptorText.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!treeDigest) {
    return { ok: false, reason: `${rootLabel} descriptor 缺少 treeDigest` };
  }
  if (observedDigest !== treeDigest) {
    return {
      ok: false,
      reason: `${rootLabel} descriptor treeDigest 与 Registry 观察不一致: ${treeDigest} !== ${observedDigest}`,
    };
  }
  const declaredAttestation = descriptorText.match(/deterministicAttestation:\s*(sha256:[a-f0-9]{64})/)?.[1] || null;
  const conformanceDir = conformanceDirOverride || join(rootDir, 'conformance');
  let lastRun;
  try {
    lastRun = JSON.parse(readFileSync(join(conformanceDir, 'last-run.json'), 'utf8'));
  } catch (error) {
    return { ok: false, reason: `${rootLabel} last-run.json 缺失或不可读: ${error.message}` };
  }
  if (lastRun.status !== 'PASS') {
    return { ok: false, reason: `${rootLabel} last-run.json status !== PASS: ${lastRun.status}` };
  }
  if (lastRun.bundleDigest !== treeDigest) {
    return { ok: false, reason: `${rootLabel} last-run.json bundleDigest 陈旧: ${lastRun.bundleDigest} !== ${treeDigest}` };
  }
  if (!declaredAttestation || lastRun.attestation?.digest !== declaredAttestation) {
    return { ok: false, reason: `${rootLabel} attestation.digest 与 deterministicAttestation 不一致: ${lastRun.attestation?.digest} !== ${declaredAttestation}` };
  }
  let bq;
  try {
    bq = JSON.parse(readFileSync(join(conformanceDir, 'behavior-qualification.json'), 'utf8'));
  } catch (error) {
    return { ok: false, reason: `${rootLabel} behavior-qualification.json 缺失或不可解析: ${error.message}` };
  }
  if (bq.qualificationStatus !== 'QUALIFIED') {
    return { ok: false, reason: `${rootLabel} behavior-qualification.json status !== QUALIFIED: ${bq.qualificationStatus}` };
  }
  const localIdentity = rootLabel === 'root'
    ? {
        bundleDigest: bq.evidence?.bundleDigest,
        deterministicAttestation: bq.evidence?.deterministicAttestation,
      }
    : bq.evidence?.scenarioIdentities?.[rootLabel];
  if (localIdentity?.bundleDigest !== treeDigest) {
    return { ok: false, reason: `${rootLabel} behavior-qualification.json 本地 bundleDigest 陈旧: ${localIdentity?.bundleDigest} !== ${treeDigest}` };
  }
  if (!declaredAttestation || localIdentity?.deterministicAttestation !== declaredAttestation) {
    return { ok: false, reason: `${rootLabel} behavior-qualification.json 本地 deterministicAttestation 不一致: ${localIdentity?.deterministicAttestation} !== ${declaredAttestation}` };
  }
  // 资格主体闭包：复算 buildQualificationSubject(rootDir) 与
  // bq.evidence.qualificationSubjects[rootLabel] 精确匹配；README 等
  // 非 bundle 文件变化会改变资格主体但不改变 bundle digest，必须在此
  // 阻止错误 SKIP
  if (!checkQualificationSubject) return { ok: true, treeDigest };
  try {
    const observed = buildQualificationSubject(rootDir);
    const expected = bq.evidence?.qualificationSubjects?.[rootLabel];
    if (!expected) {
      return { ok: false, reason: `${rootLabel} behavior-qualification.json 缺少 qualificationSubjects.${rootLabel}` };
    }
    if (observed.algorithm !== expected.algorithm || observed.digest !== expected.digest) {
      return {
        ok: false,
        reason: `${rootLabel} 资格主体陈旧: qualificationSubjects.${rootLabel} digest ${expected.digest} !== 复算值 ${observed.digest}`,
      };
    }
  } catch (error) {
    return { ok: false, reason: `${rootLabel} 资格主体复算失败: ${error.message}` };
  }
  return { ok: true, treeDigest };
}

/**
 * SKIP 加深判定（R25 F-01 + R26 F-02 + R32 三根闭包 + 资格主体闭包）：
 * 除 root bundle digest 匹配外，还要求 root、Codex adapter、Claude
 * adapter 三个 canonical root 各自的 descriptor / last-run.json /
 * behavior-qualification.json 本地身份一致，以及资格主体
 * （buildQualificationSubject）一致；任一不满足返回原因。
 */
function evidenceConsistency(rootTreeDigest) {
  let rootConformanceDir;
  try {
    rootConformanceDir = resolveConformanceDir({ env: process.env, pluginRoot });
  } catch (error) {
    return { ok: false, reason: `CONFORMANCE_DIR_INVALID: ${error.message}` };
  }
  // 1. 先核查 root 自身的 descriptor / last-run / behavior identity，
  // 暂缓资格主体。root 的发布主体包含两个 adapter；若 adapter 证据被
  // 篡改，先报 adapter 的直接原因，避免被 root 的派生主体漂移遮蔽。
  const rootIdentityResult = checkSingleRoot(
    pluginRoot,
    'root',
    rootTreeDigest,
    rootConformanceDir,
    false,
  );
  if (!rootIdentityResult.ok) return rootIdentityResult;
  // 2. Codex adapter canonical root
  const codexRoot = join(pluginRoot, 'adapters', 'codex');
  const codexResult = checkSingleRoot(
    codexRoot,
    'codex',
    observeDigest(codexRoot),
  );
  if (!codexResult.ok) return codexResult;
  // 3. Claude adapter canonical root
  const claudeRoot = join(pluginRoot, 'adapters', 'claude');
  const claudeResult = checkSingleRoot(
    claudeRoot,
    'claude',
    observeDigest(claudeRoot),
  );
  if (!claudeResult.ok) return claudeResult;
  // 4. adapter 直接身份均一致后，再核查覆盖整个发布包的 root 资格主体。
  // README 等不改变 bundle digest 的文件漂移会在这里被阻断。
  const rootSubjectResult = checkSingleRoot(
    pluginRoot,
    'root',
    rootTreeDigest,
    rootConformanceDir,
  );
  if (!rootSubjectResult.ok) return rootSubjectResult;
  return { ok: true };
}

// 顶层兜底（R27 F-01 + R28 F-01）：完整入口（含内部模块加载）包在
// 顶层 try/catch 中；entryPhase 跟踪当前位置，任何未被内层处理的
// 非结构化异常一律尽力写标记（step: unstructured-<位置>）后非零
// 退出 + 明细
let entryPhase = 'import';

async function main() {
  // import 阶段（R28 F-01）：内部相对模块在受保护入口内动态加载；
  // 加载失败 → unstructured-import + 尽力写标记
  ({ resolveConformanceDir } = await import('./lib/precondition-diagnostics.mjs'));
  ({ buildQualificationSubject } = await import('./lib/behavior-qualification.mjs'));

  entryPhase = 'observe';
  const observed = observeDigest();
  entryPhase = 'declared';
  const declared = declaredTreeDigest();
  entryPhase = 'consistency';
  const consistency = evidenceConsistency(declared);
  entryPhase = 'marker';
  // SKIP 第一条件（R26 F-01）：前次失败标记存在则永不 SKIP，
  // 并在入口输出如实携带前次失败明细
  const previousFailure = readMarker();
  entryPhase = 'gate';

  if (observed === declared && consistency.ok && !previousFailure) {
    process.stdout.write(`${JSON.stringify({
      status: 'SKIP',
      reason: 'digest-and-evidence-match',
      digest: observed,
    }, null, 2)}\n`);
    process.exit(0);
  }

  // 不一致或存在前次失败标记：需要真实刷新证据；先验证三个 env roots 前置
  const missing = REQUIRED_ENV.filter(name =>
    !process.env[name] || !isAbsolute(process.env[name]) || !existsSync(process.env[name]));
  if (missing.length > 0) {
    fail('EVIDENCE_REFRESH_ENV_ROOTS_REQUIRED', {
      observedDigest: observed,
      declaredTreeDigest: declared,
      missing,
      required: REQUIRED_ENV,
      ...(consistency.ok ? {} : { evidenceStaleReason: consistency.reason }),
      ...(previousFailure ? { previousFailure } : {}),
      hint: 'export 三个 env roots 后重跑 pnpm --dir packages/e2e-test evidence:refresh；' +
        'bundle 与 treeDigest 不一致时不得绕过合法刷新（conformance-runner + behavior-qualification-harness）',
    });
  }

  process.stdout.write(`${JSON.stringify({
    status: 'STALE_DETECTED',
    observedDigest: observed,
    declaredTreeDigest: declared,
    ...(consistency.ok ? {} : { evidenceStaleReason: consistency.reason }),
    ...(previousFailure ? { previousFailure } : {}),
  })}\n`);

  entryPhase = 'transaction';
  // 失败回滚（R25 F-01 + R26 F-01）：对齐前备份原 treeDigest；步骤 1-5
  // 任何失败 → 恢复原值 + 写失败标记 + FAIL_CLOSED；回滚写入本身失败时
  // 明细含 rollbackError，标记成为下次不 SKIP 的防线
  const backupTreeDigest = declared;
  try {
    // 1. 先对齐 treeDigest 到 Registry 观察值（机械观察；conformance 全部
    //    SPI 检查以 descriptor treeDigest 为信任基线，陈旧时级联 REJECTED，
    //    必须先对齐 runner 才可能 PASS）
    refreshTreeDigest(observed);

    // 2. conformance-runner --finalize-attestation：刷新 last-run.json 与
    //    descriptor deterministicAttestation（descriptor 在 bundle roots 之外，
    //    不会递归改变 treeDigest）
    runStep('conformance-runner', process.execPath, [
      join(pluginRoot, 'scripts', 'conformance-runner.mjs'),
      '--finalize-attestation',
    ]);

    // 3. pnpm build：同步 adapters（attestation/descriptor/last-run 变化后
    //    behavior-qualification-harness 的内部 build --check 才能通过）
    runStep('pnpm-build', 'pnpm', ['build']);

    // 4. adapter conformance finalize：让每个 adapter 自己的
    //    conformance-runner --finalize-attestation 写入 descriptor
    //    attestation 与 last-run.json（adapter 是独立 canonical root，
    //    其 conformance 证据不得从 root 覆盖）
    runStep('codex-adapter-conformance', process.execPath, [
      join(pluginRoot, 'adapters', 'codex', 'scripts', 'conformance-runner.mjs'),
      '--finalize-attestation',
    ]);
    runStep('claude-adapter-conformance', process.execPath, [
      join(pluginRoot, 'adapters', 'claude', 'scripts', 'conformance-runner.mjs'),
      '--finalize-attestation',
    ]);

    // 5. behavior-qualification-harness --finalize：刷新 behavior-qualification.json
    //    （其 finalize 对 root/codex/claude 三个 canonical root 一致写入）
    runStep('behavior-qualification-harness', process.execPath, [
      join(pluginRoot, 'scripts', 'behavior-qualification-harness.mjs'),
      '--finalize',
    ]);

    // 6. 复算确认：root bundle 观察值与 treeDigest 一致，且三个
    //    canonical root 各自证据一致（conformance/ 不在 bundle roots，
    //    证据写入不递归改变 digest）
    const confirmed = observeDigest();
    const confirmedDeclared = declaredTreeDigest();
    if (confirmed !== observed || confirmedDeclared !== observed) {
      const mismatchError = new Error('EVIDENCE_REFRESH_RECOMPUTE_MISMATCH');
      mismatchError.step = 'recompute-confirm';
      mismatchError.details = {
        refreshedDigest: observed,
        confirmedObserved: confirmed,
        confirmedDeclared,
      };
      throw mismatchError;
    }
    // 三根复算：确认 root、Codex、Claude 三个 canonical root 各自的
    // descriptor / last-run.json / behavior-qualification.json 本地身份一致
    const threeRootCheck = evidenceConsistency(observed);
    if (!threeRootCheck.ok) {
      const threeRootError = new Error('EVIDENCE_REFRESH_THREE_ROOT_INCONSISTENT');
      threeRootError.step = 'three-root-confirm';
      threeRootError.details = { reason: threeRootCheck.reason };
      throw threeRootError;
    }
  } catch (error) {
    // 回滚写入本身可能失败（如 EACCES）：尽力恢复，失败时如实记录
    // rollbackError——此时标记文件是下次不 SKIP 的唯一防线
    let rollbackError = null;
    try {
      refreshTreeDigest(backupTreeDigest);
    } catch (rbError) {
      rollbackError = rbError.message;
    }
    fail('FAIL_CLOSED', {
      step: error.step || 'unknown',
      reason: error.message,
      ...(error.details || {}),
      rolledBackTreeDigest: backupTreeDigest,
      rollbackSucceeded: rollbackError === null,
      ...(rollbackError ? { rollbackError } : {}),
    });
  }

  // 仅完整成功（全部步骤 + 复算一致）才清除前次失败标记
  clearMarker();

  process.stdout.write(`${JSON.stringify({
    status: 'REFRESHED',
    previousTreeDigest: declared,
    treeDigest: declaredTreeDigest(),
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  // 顶层兜底出口（R27 F-01 + R28 F-01）：内层 fail() 已 process.exit
  // 的路径不会到达这里；到达这里的都是未被内层处理的非结构化异常
  // （含内部模块动态 import 失败，step: unstructured-import）
  const step = `unstructured-${entryPhase}`;
  const markerWriteError = writeMarker({
    step,
    reason: error.message,
    ...(error.code ? { code: error.code } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    status: 'FAIL_CLOSED',
    error: 'UNSTRUCTURED_ENTRY_FAILURE',
    step,
    reason: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(markerWriteError ? { markerWriteError } : {}),
  }, null, 2)}\n`);
  process.exit(1);
}
