#!/usr/bin/env node

/** 方法正向试验 prepare / run / verify 控制平面。 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildQualificationSubject, containsAbsolutePath, parseClaudeEvents, parseCodexEvents,
  snapshotTree, stableDigest,
} from './lib/behavior-qualification.mjs';
import { buildClaudeReceiptProjection, buildCodexReceiptProjection, normalizeHostReceipt } from './lib/codex-receipt-projection.mjs';
import { computeStageChainDigest } from './lib/run-root.mjs';
import { validateStageResult } from './lib/stage-validation.mjs';
import {
  FORWARD_STAGES, classifyForwardTrial, createForwardValidators, digestFile, digestTree,
  listFiles, resolveForwardBudget, resolveForwardTimeoutMs, signTrialResult, trialId,
  verifyTrialResult,
} from './lib/method-forward-trials.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const action = argv[0];
const value = flag => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const jsonMode = argv.includes('--json');

if (process.argv[1]?.endsWith('method-forward-trial-runner.mjs')) {
  try {
    let result;
    if (action === 'prepare') result = prepareTrial();
    else if (action === 'run') result = await runTrial();
    else if (action === 'verify') result = verifyTrial();
    else throw coded('FORWARD_ACTION_INVALID');
    process.stdout.write(`${JSON.stringify(result, null, jsonMode ? 2 : 0)}\n`);
    if (result.status === 'FAIL' || result.status === 'BLOCKED') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: codeOf(error) }, null, jsonMode ? 2 : 0)}\n`);
    process.exitCode = 1;
  }
}

function prepareTrial() {
  const root = requireAbsolute('--root');
  const hostId = value('--host');
  const packageId = value('--package');
  const tarPath = requireAbsolute('--tar');
  const packageManifestPath = requireAbsolute('--package-manifest');
  const hostCommand = requireAbsolute('--host-command');
  const evidenceMode = value('--evidence-mode') || 'real';
  if (!['codex', 'claude-code'].includes(hostId) || !/^fwd-[a-z0-9-]+$/.test(packageId || '')) throw coded('FORWARD_TRIAL_IDENTITY_INVALID');
  if (!['real', 'synthetic'].includes(evidenceMode)) throw coded('FORWARD_EVIDENCE_MODE_INVALID');
  if (existsSync(root) && readdirSync(root).length) throw coded('FORWARD_ROOT_COLLISION');
  for (const path of [tarPath, packageManifestPath, hostCommand]) if (!existsSync(path)) throw coded('FORWARD_PREPARE_INPUT_MISSING');
  const manifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
  if (manifest.packageId !== packageId || manifest.host !== hostId || digestFile(tarPath) !== manifest.tarballDigest) {
    throw coded('FORWARD_PACKAGE_DIGEST_MISMATCH');
  }
  const archive = readTar(readFileSync(tarPath));
  const expected = ['START.md', 'raw/feature.json', 'raw/goal.md', 'raw/project-facts.json', 'raw/scenario.md'];
  if (JSON.stringify([...archive.keys()].sort()) !== JSON.stringify(expected)) throw coded('FORWARD_PACKAGE_FILESET_INVALID');
  for (const bytes of archive.values()) if (forbiddenContent(String(bytes))) throw coded('FORWARD_PACKAGE_FORBIDDEN_CONTENT');

  const projectRoot = join(root, 'project');
  const workRoot = join(root, 'work');
  const controlRoot = join(root, 'control');
  const evidenceRoot = join(root, 'evidence');
  for (const path of [projectRoot, workRoot, controlRoot, evidenceRoot, join(projectRoot, 'results')]) mkdirSync(path, { recursive: true });
  for (const [name, bytes] of archive) {
    const target = join(projectRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  const launcherName = '.e2e-test-run-author';
  const launcherPath = join(projectRoot, launcherName);
  const driverPath = join(pluginRoot, 'scripts', 'method-forward-author-driver.mjs');
  const stageInputsPath = join(projectRoot, 'stage-inputs.json');
  const authorOutputPath = join(projectRoot, 'results', 'author-output.json');
  const driverArgs = [
    driverPath, '--project-root', projectRoot, '--stage-inputs', stageInputsPath,
    '--output', authorOutputPath, '--package', packageId, '--host', hostId,
  ];
  const launcherContent = `#!/bin/sh\nexec ${[process.execPath, ...driverArgs].map(shellQuote).join(' ')}\n`;
  writeFileSync(launcherPath, launcherContent, { flag: 'wx', mode: 0o700 });
  const pluginSubject = buildQualificationSubject(pluginRoot);
  const hostVersion = hostVersionOf(hostCommand);
  const planCore = {
    schemaVersion: 1,
    kind: 'method-forward-prepared',
    trialId: trialId(hostId, packageId),
    packageId,
    hostId,
    evidenceMode,
    package: {
      tarballDigest: manifest.tarballDigest,
      rawInputDigest: manifest.rawInputDigest,
      projectFactsDigest: manifest.projectFactsDigest,
      goalDigest: manifest.goalDigest,
      files: expected.map(path => ({ path, contentDigest: digestFile(join(projectRoot, path)) })),
    },
    subject: { pluginSubjectDigest: pluginSubject.digest },
    launcher: { path: launcherName, contentDigest: digestFile(launcherPath) },
    host: { version: hostVersion, executableDigest: digestFile(realpathSync(hostCommand)) },
    contextPolicy: {
      allowedInputs: ['START.md', 'raw/**', 'public-plugin/**'],
      forbiddenClasses: ['expected-artifact', 'rubric-result', 'other-trial-output', 'planning-review'],
    },
    layout: { project: 'project', work: 'work', evidence: 'evidence' },
  };
  const plan = { ...planCore, digest: stableDigest(planCore) };
  writeFileSync(join(controlRoot, 'prepared.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const local = {
    hostCommand: realpathSync(hostCommand),
    pluginRoot: realpathSync(pluginRoot),
    projectRoot: realpathSync(projectRoot),
    workRoot: realpathSync(workRoot),
    evidenceRoot: realpathSync(evidenceRoot),
  };
  writeFileSync(join(controlRoot, 'launch-control.json'), `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
  return { status: 'PREPARED', trialId: plan.trialId, digest: plan.digest };
}

async function runTrial() {
  const root = requireAbsolute('--root');
  // Recovery-25 WP1：预算经共享 helper 解析（默认 1,200,000ms、上限 1,800,000ms、
  // 下限 1,000ms），与 reviewer 同构；非法预算失败关闭 FORWARD_TIMEOUT_INVALID。
  // 优先级保持：--timeout-ms > E2E_TEST_FORWARD_TIMEOUT_MS > 默认值。
  // R27 杠杆 3：resolveForwardBudget 同时返回来源（cli|env|default），记入 receipt 与 trial-result。
  const { timeoutMs, source: budgetSource } = resolveForwardBudget(value('--timeout-ms'), process.env.E2E_TEST_FORWARD_TIMEOUT_MS);
  const { plan, local } = loadPrepared(root);
  verifyPreparedState(root, plan, local);
  // WP1E：公开文件装载列表必须实际包含 author skill 声明为必读的全部 references，
  // 含 findings-catalog.md 与 proof-reconciliation.md（R23 装载缺口）。
  const skillPaths = [
    join(pluginRoot, 'skills', 'e2e-test-author', 'SKILL.md'),
    join(pluginRoot, 'references', 'methodology.md'),
    join(pluginRoot, 'references', 'candidate-assessment.md'),
    join(pluginRoot, 'references', 'matrix-model.md'),
    join(pluginRoot, 'references', 'findings-catalog.md'),
    join(pluginRoot, 'references', 'proof-reconciliation.md'),
    ...['inspect', 'assess', 'design'].map(stage => join(pluginRoot, 'stages', stage, 'SKILL.md')),
  ];
  const schemaPaths = ['inspection.json', 'candidate-assessment.json', 'matrix.json']
    .map(name => join(pluginRoot, 'schemas', name));
  for (const path of [...skillPaths, ...schemaPaths]) if (!existsSync(path)) throw coded('FORWARD_PUBLIC_METHOD_MISSING');
  const stageInputsPath = join(local.projectRoot, 'stage-inputs.json');
  const authorOutputPath = join(local.projectRoot, 'results', 'author-output.json');
  const driverPath = join(pluginRoot, 'scripts', 'method-forward-author-driver.mjs');
  const launcherCommand = `./${plan.launcher.path}`;
  const receiptSchemaPath = join(pluginRoot, 'schemas', 'method-forward-host-receipt.json');
  const receiptValidators = createForwardValidators(pluginRoot);
  // 面 A：两个宿主的结构化输出约束各自无法直接接受规范 receipt Schema 的某一部分
  // （成功/失败互斥语义不得删除）。由 scripts 层从规范 Schema 确定性派生宿主投影，
  // 宿主输出随后经规范 Schema 的 AJV 二次校验恢复全部严格判定；投影层只负责让宿主
  // 能写出结构化输出，不裁决互斥：
  // - Codex --output-schema 不接受顶层 oneOf → 单对象投影（null 联合表达互有字段）；
  // - Claude --json-schema 在失败路径拒绝 failure 序列化为 JSON 字符串（must be
  //   object → 重试耗尽 → exit 1，控制平面拿不到结构化失败 receipt）→ 保留顶层互斥
  //   oneOf、仅把失败分支 failure 放宽为 oneOf [object, string] 的投影。
  let hostReceiptSchemaPath = receiptSchemaPath;
  let hostReceiptProjectionDigest = null;
  if (plan.hostId === 'codex') {
    const projection = buildCodexReceiptProjection(JSON.parse(readFileSync(receiptSchemaPath, 'utf8')));
    hostReceiptSchemaPath = join(root, 'control', 'codex-output-projection.json');
    writeFileSync(hostReceiptSchemaPath, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
    hostReceiptProjectionDigest = stableDigest(projection);
  } else if (plan.hostId === 'claude-code') {
    const projection = buildClaudeReceiptProjection(JSON.parse(readFileSync(receiptSchemaPath, 'utf8')));
    hostReceiptSchemaPath = join(root, 'control', 'claude-output-projection.json');
    writeFileSync(hostReceiptSchemaPath, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
    hostReceiptProjectionDigest = stableDigest(projection);
  }
  const prompt = buildPrompt({ plan, skillPaths, schemaPaths, stageInputsPath, driverCommand: launcherCommand });
  const env = scrubbedEnvironment({
    E2E_TEST_RUN_ROOT: join(local.workRoot, 'runs'),
    E2E_FORWARD_TRIAL_ROOT: root,
    E2E_FORWARD_DRIVER_COMMAND: launcherCommand,
    E2E_FORWARD_DRIVER_PATH: driverPath,
    E2E_FORWARD_PROJECT_ROOT: local.projectRoot,
    E2E_FORWARD_WORK_ROOT: local.workRoot,
    E2E_FORWARD_STAGE_INPUTS: stageInputsPath,
    E2E_FORWARD_AUTHOR_OUTPUT: authorOutputPath,
    E2E_FORWARD_PACKAGE_ID: plan.packageId,
    E2E_FORWARD_HOST_ID: plan.hostId,
    E2E_FORWARD_SKILL_PATH: skillPaths[0],
    E2E_FORWARD_EVIDENCE_MODE: plan.evidenceMode,
    ...(plan.evidenceMode === 'synthetic' && process.env.E2E_FAKE_FORWARD_MODE
      ? { E2E_FAKE_FORWARD_MODE: process.env.E2E_FAKE_FORWARD_MODE }
      : {}),
  });
  const hostArgs = plan.hostId === 'codex'
    ? buildCodexArgs({ receiptSchemaPath: hostReceiptSchemaPath, projectRoot: local.projectRoot, workRoot: local.workRoot, prompt })
    : buildClaudeArgs({ prompt, receiptSchemaPath: hostReceiptSchemaPath, projectRoot: local.projectRoot, skillPaths, schemaPaths, stageInputsPath, driverCommand: launcherCommand, workRoot: local.workRoot, environment: env });
  const invocationCore = {
    hostId: plan.hostId,
    executableDigest: digestFile(local.hostCommand),
    argumentsDigest: stableDigest(hostArgs),
    preparedDigest: plan.digest,
  };
  const before = {
    input: protectedInputDigest(local.projectRoot),
    plugin: buildQualificationSubject(pluginRoot).digest,
    writable: digestWritable(local.projectRoot, local.workRoot),
  };
  // R27 杠杆 2：异步 spawn + 看门狗行动强制。
  // 看门狗检测长时间无工具产出（无 Write/无有效输出），确定性失败关闭——
  // 杀子进程并把该 trial 记为诚实 FAIL（终态 receipt 完整），而非干等到预算耗尽。
  // 无工具产出超时默认 180,000ms（3 分钟），可通过 E2E_TEST_NO_TOOL_TIMEOUT_MS 覆盖。
  const noToolTimeoutMs = Number(process.env.E2E_TEST_NO_TOOL_TIMEOUT_MS) || 180000;
  const invocation = await spawnWithWatchdog(local.hostCommand, hostArgs, {
    cwd: local.projectRoot, env, timeoutMs, noToolTimeoutMs, hostId: plan.hostId,
  });
  const after = {
    input: protectedInputDigest(local.projectRoot),
    plugin: buildQualificationSubject(pluginRoot).digest,
    writable: digestWritable(local.projectRoot, local.workRoot),
  };
  mkdirSync(local.evidenceRoot, { recursive: true });
  writeFileSync(join(local.evidenceRoot, 'events.jsonl'), invocation.stdout || '');
  writeFileSync(join(local.evidenceRoot, 'stderr.log'), invocation.stderr || '');
  // 解析宿主最终结构化 receipt：控制平面不信任退出码，只信任与现场一致的结构化状态。
  let hostReceipt = null;
  try {
    const parsedHost = plan.hostId === 'codex' ? parseCodexEvents(invocation.stdout || '') : parseClaudeEvents(invocation.stdout || '');
    if (parsedHost?.receipt && typeof parsedHost.receipt === 'object') hostReceipt = parsedHost.receipt;
  } catch {
    hostReceipt = null;
  }
  // 二次校验：宿主输出（Codex 经投影、Claude 经内联规范 Schema）规范化后必须通过
  // 规范 receipt Schema 的 AJV 校验；投影层可写的混合成功/失败形状在规范层失败关闭。
  const canonicalReceipt = hostReceipt ? normalizeHostReceipt(hostReceipt) : null;
  const hostReceiptSchemaValid = canonicalReceipt ? receiptValidators.receipt(canonicalReceipt) : false;
  const hostReceiptStatus = typeof canonicalReceipt?.status === 'string' ? canonicalReceipt.status : null;
  const authorOutputPresent = existsSync(authorOutputPath);
  const receiptCore = {
    schemaVersion: 1,
    kind: 'method-forward-run-receipt',
    trialId: plan.trialId,
    preparedDigest: plan.digest,
    evidenceMode: plan.evidenceMode,
    invocation: invocationCore,
    exit: {
      kind: invocation.exitKind,
      code: invocation.status,
      signal: invocation.signal || null,
    },
    // R27 杠杆 3：预算可观测——记录实际生效 timeoutMs 及来源（cli|env|default）。
    budget: { timeoutMs, source: budgetSource },
    observations: {
      eventStreamDigest: digestFile(join(local.evidenceRoot, 'events.jsonl')),
      stderrDigest: digestFile(join(local.evidenceRoot, 'stderr.log')),
      inputBeforeDigest: before.input,
      inputAfterDigest: after.input,
      pluginBeforeDigest: before.plugin,
      pluginAfterDigest: after.plugin,
      writableBeforeDigest: before.writable,
      writableAfterDigest: after.writable,
      hostReceiptStatus,
      hostReceiptSchemaValid,
      hostReceiptProjectionDigest,
      authorOutputPresent,
    },
  };
  const receipt = { ...receiptCore, digest: stableDigest(receiptCore) };
  writeFileSync(join(local.evidenceRoot, 'run-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  let status = 'FAIL';
  let code = receipt.exit.kind;
  if (receipt.exit.kind === 'EXITED' && receipt.exit.code === 0) {
    // 宿主外层 exit 0 不得掩盖业务失败：规范二次校验通过的成功 receipt 且 author-output
    // 真实存在才算 RUN_COMPLETE。
    if (hostReceiptSchemaValid && hostReceiptStatus === 'AUTHOR_PREVIEW_COMPLETE' && authorOutputPresent) {
      status = 'RUN_COMPLETE';
      code = 'EXITED';
    } else if (hostReceiptSchemaValid && ['AUTHOR_DRIVER_FAILED', 'BLOCKED', 'NEEDS_INPUT'].includes(hostReceiptStatus)) {
      code = 'HOST_RECEIPT_FAILURE';
    } else if (hostReceipt && !hostReceiptSchemaValid) {
      // 投影层可写但规范层拒绝（如混合成功/失败 receipt、残缺字段）。
      code = 'HOST_RECEIPT_INCONSISTENT';
    } else if (hostReceiptStatus === 'AUTHOR_PREVIEW_COMPLETE' && !authorOutputPresent) {
      code = 'HOST_RECEIPT_INCONSISTENT';
    } else {
      code = 'HOST_RECEIPT_MISSING';
    }
  } else if (receipt.exit.kind === 'EXITED') {
    code = 'HOST_EXIT_NONZERO';
  } else if (receipt.exit.kind === 'ENFORCED_KILL') {
    // R27 杠杆 2：看门狗检测到长时间无工具产出，确定性失败关闭。
    code = 'NO_TOOL_OUTPUT_ENFORCED';
  }
  return { status, trialId: plan.trialId, code, digest: receipt.digest };
}

function verifyTrial() {
  const root = requireAbsolute('--root');
  const { plan, local } = loadPrepared(root);
  const receiptPath = join(local.evidenceRoot, 'run-receipt.json');
  if (!existsSync(receiptPath)) throw coded('FORWARD_RUN_RECEIPT_MISSING');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const receiptDigestValid = signed(receipt) && receipt.preparedDigest === plan.digest && receipt.trialId === plan.trialId;
  let parsed = null;
  let eventStreamValid = true;
  try {
    const stdout = readFileSync(join(local.evidenceRoot, 'events.jsonl'), 'utf8');
    parsed = plan.hostId === 'codex' ? parseCodexEvents(stdout) : parseClaudeEvents(stdout);
  } catch {
    eventStreamValid = false;
  }
  const launcherCommand = `./${plan.launcher.path}`;
  const skillPath = join(pluginRoot, 'skills', 'e2e-test-author', 'SKILL.md');
  const trace = validateForwardTrace(parsed?.tools || [], {
    skillPath, driverPath: launcherCommand, projectRoot: local.projectRoot,
  });
  const authorOutputPath = join(local.projectRoot, 'results', 'author-output.json');
  let authorOutput = null;
  try { authorOutput = JSON.parse(readFileSync(authorOutputPath, 'utf8')); } catch {}
  const authorIdentityValid = authorOutput?.packageId === plan.packageId && authorOutput?.hostId === plan.hostId && signed(authorOutput);
  const runRoot = authorOutput?.runId ? join(local.workRoot, 'runs', authorOutput.runId) : null;
  const chain = verifyAuthorChain(runRoot, authorOutput);
  // 成功现场必须有 results/author-output.json；失败现场它必须缺席。
  // 两种现场的期望文件集不同，但越界写入检测对两者同样严格：
  // 失败现场的工作树只允许 runs/ 前缀（驱动器中途失败可能留下部分工序结果）。
  const expectedProject = ['START.md', plan.launcher.path, 'raw/feature.json', 'raw/goal.md', 'raw/project-facts.json', 'raw/scenario.md', 'stage-inputs.json'];
  if (authorOutput) expectedProject.push('results/author-output.json');
  expectedProject.sort();
  const actualProject = listFiles(local.projectRoot).sort();
  const workTreeAuthorized = authorOutput
    ? chain.allowedWorkFiles
    : listFiles(local.workRoot).every(path => path.startsWith('runs/'));
  const unauthorizedWriteDetected = JSON.stringify(actualProject) !== JSON.stringify(expectedProject) || !workTreeAuthorized;
  const inputMutated = receipt.observations?.inputBeforeDigest !== receipt.observations?.inputAfterDigest ||
    receipt.observations?.inputAfterDigest !== protectedInputDigest(local.projectRoot);
  const pluginMutated = receipt.observations?.pluginBeforeDigest !== receipt.observations?.pluginAfterDigest ||
    receipt.observations?.pluginAfterDigest !== buildQualificationSubject(pluginRoot).digest;
  const publicEvidence = { authorOutput, preview: chain.preview, artifacts: chain.publicArtifacts };
  const absolutePathDetected = containsAbsolutePath(publicEvidence);
  // receipt 诚实性事实：失败 receipt 必须与驱动真实尝试和缺失的 author-output 一致；
  // 成功 receipt 必须有真实 author-output 支撑。两宿主 receipt 均先规范化再经规范
  // Schema 的 AJV 二次校验：投影层可写的混合形状在此失败关闭。
  const validators = createForwardValidators(pluginRoot);
  const hostReceiptShape = parsed?.receipt && typeof parsed.receipt === 'object' ? parsed.receipt : null;
  const canonicalReceiptShape = hostReceiptShape ? normalizeHostReceipt(hostReceiptShape) : null;
  const hostReceiptSchemaValid = canonicalReceiptShape ? validators.receipt(canonicalReceiptShape) : false;
  const hostReceiptStatus = typeof canonicalReceiptShape?.status === 'string' ? canonicalReceiptShape.status : null;
  const isFailureReceiptStatus = ['AUTHOR_DRIVER_FAILED', 'BLOCKED', 'NEEDS_INPUT'].includes(hostReceiptStatus);
  const failureCodeValid = /^[A-Z][A-Z0-9_]+$/.test(canonicalReceiptShape?.failure?.code || '');
  // 与 validateForwardTrace 的 normalized 保持一致：仅剥离宿主仪表化的尾随取退出码后缀
  // （`; echo "EXIT_CODE=$?"`），不放宽任何其它命令合同。
  const normalizedCommand = value => String(value || '').replace(/[\\'\"]/g, '').replace(/\s+/g, ' ').replace(/;\s*echo\s+(?:EXIT_CODE=)?\$\?$/, '').trim();
  const driverAttempts = (parsed?.tools || []).filter(item => item.kind === 'command' && normalizedCommand(item.value).includes(normalizedCommand(launcherCommand)));
  const driverAttempted = driverAttempts.length > 0;
  const authorOutputPresent = Boolean(authorOutput);
  const facts = {
    hostUnavailable: receipt.exit?.kind === 'SPAWN_FAILED',
    // R27 杠杆 2：看门狗强制杀进程（长时间无工具产出）。
    enforcedKill: receipt.exit?.kind === 'ENFORCED_KILL',
    timedOut: receipt.exit?.kind === 'TIMEOUT',
    exitCode: receipt.exit?.code,
    eventStreamValid: eventStreamValid && receiptDigestValid,
    skillReadVerified: trace.skillReadVerified,
    authorCommandVerified: trace.authorCommandVerified,
    unexpectedToolDetected: trace.unexpectedToolDetected,
    inputMutated,
    pluginMutated,
    unauthorizedWriteDetected,
    absolutePathDetected,
    failureReceiptHonest: isFailureReceiptStatus && failureCodeValid && driverAttempted && !authorOutputPresent && hostReceiptSchemaValid,
    failureReceiptInconsistent: isFailureReceiptStatus && (!failureCodeValid || !driverAttempted || authorOutputPresent || !hostReceiptSchemaValid),
    successReceiptInconsistent: (hostReceiptStatus === 'AUTHOR_PREVIEW_COMPLETE' && !authorOutputPresent) || (hostReceiptStatus !== null && !hostReceiptSchemaValid),
    authorChainCompleted: chain.completed && authorIdentityValid,
    previewValid: chain.previewValid,
  };
  const [status, code] = classifyForwardTrial(facts);
  const writeDelta = [
    ...actualProject.filter(path => !path.startsWith('raw/') && path !== 'START.md' && path !== plan.launcher.path).map(path => `project/${path}`),
    ...listFiles(local.workRoot).map(path => `work/${path}`),
  ].sort();
  const unsigned = {
    schemaVersion: 1,
    trialId: plan.trialId,
    packageId: plan.packageId,
    hostId: plan.hostId,
    evidenceMode: plan.evidenceMode,
    status,
    code,
    input: {
      tarballDigest: plan.package.tarballDigest,
      rawInputDigest: plan.package.rawInputDigest,
      projectFactsDigest: plan.package.projectFactsDigest,
      goalDigest: plan.package.goalDigest,
      pluginSubjectDigest: plan.subject.pluginSubjectDigest,
    },
    invocation: {
      cliVersion: plan.host.version,
      exitCode: receipt.exit?.code ?? null,
      timedOut: receipt.exit?.kind === 'TIMEOUT' || receipt.exit?.kind === 'ENFORCED_KILL',
      hostInvocationDigest: stableDigest(receipt.invocation ?? null),
      eventStreamDigest: receipt.observations?.eventStreamDigest || stableDigest(null),
      skillReadVerified: trace.skillReadVerified,
      authorCommandVerified: trace.authorCommandVerified,
      unexpectedToolDetected: trace.unexpectedToolDetected,
      // R27 杠杆 3：预算可观测——记录实际生效 timeoutMs 及来源。
      budgetTimeoutMs: receipt.budget?.timeoutMs ?? null,
      budgetSource: receipt.budget?.source ?? null,
    },
    author: {
      chainCompleted: chain.completed && authorIdentityValid,
      stages: chain.stages,
      stageChainDigest: chain.stageChainDigest,
      stageResultsManifestDigest: chain.stageResultsManifestDigest,
      previewDigest: chain.preview?.previewDigest ?? null,
      artifactPackageDigest: chain.artifactPackageDigest,
      plannedWrites: chain.preview?.plannedWrites?.map(item => ({ path: item.path, contentDigest: item.contentDigest })) ?? [],
      evidenceRefs: chain.evidenceRefs,
    },
    isolation: {
      inputUnmodified: !inputMutated,
      pluginUnmodified: !pluginMutated,
      zeroUnauthorizedWrites: !unauthorizedWriteDetected,
      absolutePathDetected,
      writeDelta,
    },
  };
  const result = signTrialResult(unsigned);
  const checked = verifyTrialResult(result, validators.trial);
  if (!checked.valid) {
    result.status = 'BLOCKED';
    result.code = 'FORWARD_RESULT_INVALID';
    delete result.digest;
    result.digest = stableDigest(result);
  }
  writeFileSync(join(local.evidenceRoot, 'trial-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function verifyAuthorChain(runRoot, authorOutput) {
  const fallback = {
    completed: false, stages: [], stageChainDigest: null, stageResultsManifestDigest: null,
    preview: null, previewValid: false, artifactPackageDigest: null, evidenceRefs: [],
    publicArtifacts: null, allowedWorkFiles: false,
  };
  if (!runRoot || !existsSync(runRoot)) return fallback;
  const stages = [];
  const manifestItems = [];
  for (const stage of FORWARD_STAGES) {
    const validated = validateStageResult(runRoot, stage, { pluginRoot });
    if (validated.status !== 'PASS' || validated.result?.status !== 'PASS') break;
    stages.push(stage);
    manifestItems.push({ stage, path: `work/runs/${basename(runRoot)}/stage-results/${stage}.json`, digest: digestFile(join(runRoot, 'stage-results', `${stage}.json`)) });
  }
  let stageChainDigest = null;
  try { stageChainDigest = computeStageChainDigest(runRoot, FORWARD_STAGES); } catch {}
  let preview = null;
  try { preview = JSON.parse(readFileSync(join(runRoot, 'preview-manifest.json'), 'utf8')); } catch {}
  const previewValid = preview?.status === 'PREVIEW_READY' && preview?.stageChainDigest === stageChainDigest &&
    preview?.plannedWrites?.length === 4 && !existsSync(join(runRoot, 'commit.lock'));
  const evidenceRefs = [
    ...manifestItems.map(item => item.path),
    ...listFiles(join(runRoot, 'intermediates')).map(path => `work/runs/${basename(runRoot)}/intermediates/${path}`),
    `work/runs/${basename(runRoot)}/preview-manifest.json`,
    'project/results/author-output.json',
  ].filter((value, index, values) => values.indexOf(value) === index).sort();
  let packageManifest = null;
  let publicArtifacts = null;
  try {
    packageManifest = JSON.parse(readFileSync(join(runRoot, 'intermediates', 'artifact-package-manifest.json'), 'utf8'));
    publicArtifacts = {
      artifact: JSON.parse(readFileSync(join(runRoot, 'intermediates', 'artifact.json'), 'utf8')),
      matrix: JSON.parse(readFileSync(join(runRoot, 'intermediates', 'matrix.json'), 'utf8')),
      packageManifest,
    };
  } catch {}
  const allowedPrefixes = ['stage-results/', 'intermediates/', 'outputs/', 'raw-inputs/'];
  const allowedExact = ['run-manifest.json', 'preview-manifest.json', 'commit-secret'];
  const workFiles = listFiles(runRoot);
  const allowedWorkFiles = workFiles.every(path => allowedExact.includes(path) || allowedPrefixes.some(prefix => path.startsWith(prefix)));
  return {
    completed: stages.length === FORWARD_STAGES.length && previewValid && Boolean(publicArtifacts),
    stages, stageChainDigest,
    stageResultsManifestDigest: manifestItems.length === FORWARD_STAGES.length ? stableDigest(manifestItems) : null,
    preview, previewValid,
    artifactPackageDigest: /^sha256:[a-f0-9]{64}$/.test(packageManifest?.packageDigest || '') ? packageManifest.packageDigest : null,
    evidenceRefs, publicArtifacts, allowedWorkFiles,
  };
}

export function validateForwardTrace(tools, { skillPath, driverPath, projectRoot }) {
  const succeeded = item => item.success === true;
  // 命令规范化：宿主（Claude/Codex 适配层）常在驱动调用后附加 `; echo "EXIT_CODE=$?"`
  // 以捕获退出码。这是宿主仪表化后缀，不改变驱动命令语义。这里仅剥离这一**精确受限**
  // 的尾随后缀，使作者命令判定反映真实驱动调用；任何其它命令改动（如追加分号命令、
  // 写入/执行类命令）不在剥离范围内，仍按原合同判定，verifier 拒绝语义不被弱化。
  const normalized = value => String(value || '').replace(/[\\'\"]/g, '').replace(/\s+/g, ' ').replace(/;\s*echo\s+(?:EXIT_CODE=)?\$\?$/, '').trim();
  const skillRead = tools.find(item => succeeded(item) && (
    (item.kind === 'read' && resolve(item.value) === resolve(skillPath)) ||
    (item.kind === 'command' && normalized(item.value).includes(normalized(skillPath)) && /(?:sed|cat)\b/.test(normalized(item.value)))
  ));
  const launcherAttempts = tools.filter(item => item.kind === 'command' && normalized(item.value).includes(normalized(driverPath)));
  const authorCommand = launcherAttempts.find(item => succeeded(item));
  const boundedCorrection = launcherAttempts.length === 2 &&
    launcherAttempts[0].success !== true && launcherAttempts[0].resultCode === 'FORWARD_STAGE_INPUT_INVALID' &&
    launcherAttempts[1].success === true;
  // 诚实失败路径：宿主只调用一次驱动，驱动返回结构化 FORWARD_* 失败码后宿主立即停止。
  // 这只放宽「失败后不得继续」的工具审计；成功判定仍要求存在成功的驱动尝试。
  const honestSingleFailure = launcherAttempts.length === 1 &&
    launcherAttempts[0].success !== true &&
    /^FORWARD_[A-Z0-9_]+$/.test(launcherAttempts[0].resultCode || '');
  const launcherSequenceValid = launcherAttempts.length === 1 && launcherAttempts[0].success === true || boundedCorrection;
  const allowed = item => {
    if (!succeeded(item)) {
      return item.kind === 'command' && normalized(item.value).includes(normalized(driverPath)) &&
        ((item.resultCode === 'FORWARD_STAGE_INPUT_INVALID' && boundedCorrection) || honestSingleFailure) &&
        item === launcherAttempts[0];
    }
    if (item.kind === 'read') return resolve(item.value).startsWith(`${resolve(pluginRoot)}/`) || resolve(item.value).startsWith(`${resolve(projectRoot)}/`);
    if (item.kind === 'write') return resolve(item.value) === resolve(projectRoot, 'stage-inputs.json');
    if (item.kind !== 'command') return false;
    const command = normalized(item.value);
    if (/\b(?:git|curl|wget|ssh|scp|npm|pnpm|yarn|rm|mv|cp|install|tee|touch|mkdir|chmod|chown|ln|dd|truncate|python|perl|ruby)\b/.test(command)) return false;
    if (command.includes(normalized(driverPath))) return launcherSequenceValid;
    if (command.includes(normalized(projectRoot, 'stage-inputs.json'))) return true;
    // 只读检查命令合同：仅放行不产生副作用的列举/查看类命令（ls 为目录/文件列举）。
    // 这是「只读检查命令扩展」而非放行任何写入/执行类命令——上方 L486 的写入/执行
    // 黑名单（git|curl|rm|mv|cp|tee|touch|mkdir|chmod|python|…）保持不变；下方
    // scopedInput 与「禁止输出重定向」守卫同样保持不变，因此 `ls > x` 一类仍被拒。
    const readOnlyInspection = /\b(?:ls|sed|cat|find|rg|wc|pwd|head|tail)\b/.test(command);
    const scopedInput = command.includes(normalized(pluginRoot)) || command.includes(normalized(projectRoot)) ||
      /(?:^|[\s;])(?:START\.md|raw(?:\/|\b))/.test(command);
    return readOnlyInspection && scopedInput && !/(?:^|[^<])>(?:>|&)?/.test(command);
  };
  const authorIndex = authorCommand?.index ?? Infinity;
  return {
    skillReadVerified: Boolean(skillRead && skillRead.index < authorIndex),
    authorCommandVerified: Boolean(authorCommand && launcherSequenceValid),
    unexpectedToolDetected: tools.some(item => !allowed(item)),
  };
}

/**
 * R27 杠杆 2：异步 spawn + 看门狗行动强制。
 *
 * 监控宿主事件流，检测长时间无工具产出（无 Write/Bash/有效输出）。
 * 看门狗触发时确定性杀掉子进程，返回 exitKind='ENFORCED_KILL'。
 * 外层预算超时仍由总计时器控制，返回 exitKind='TIMEOUT'。
 * 正常退出返回 exitKind='EXITED'。spawn 失败返回 exitKind='SPAWN_FAILED'。
 *
 * 工具事件检测：
 * - Claude：assistant 消息中的 tool_use 事件（Write/Bash/Read）
 * - Codex：item.completed 中的 command_execution/file_edit 事件
 * 任何工具事件重置看门狗计时器。
 */
async function spawnWithWatchdog(command, args, { cwd, env, timeoutMs, noToolTimeoutMs, hostId }) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let lastToolActivity = Date.now();
  let enforcedKill = false;
  let timedOut = false;
  let spawnFailed = false;

  const isToolEvent = line => {
    try {
      const event = JSON.parse(line);
      if (hostId === 'claude-code') {
        // Claude：assistant 消息中的 tool_use 事件
        if (event.type === 'assistant' && event.message?.content) {
          return event.message.content.some(block => block.type === 'tool_use');
        }
        // structured_output 也算有效产出
        if (event.type === 'result' && event.structured_output) return true;
      } else {
        // Codex：item.completed 中的 command_execution/file_edit/agent_message
        if (event.type === 'item.completed' && event.item) {
          return ['command_execution', 'file_edit', 'agent_message'].includes(event.item.type);
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });

    child.on('error', () => {
      spawnFailed = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        status: null, signal: null,
        exitKind: 'SPAWN_FAILED',
      });
    });

    // 逐行监控 stdout 以检测工具事件
    let stdoutBuffer = '';
    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // 保留不完整的最后一行
      for (const line of lines) {
        if (line.trim() && isToolEvent(line)) {
          lastToolActivity = Date.now();
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
    });

    // 看门狗：检测长时间无工具产出
    const watchdogInterval = setInterval(() => {
      if (Date.now() - lastToolActivity > noToolTimeoutMs) {
        enforcedKill = true;
        cleanup();
        child.kill('SIGTERM');
        // 5 秒后强制 SIGKILL
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000);
      }
    }, 10000);

    // 外层预算超时
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      cleanup();
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000);
    }, timeoutMs);

    function cleanup() {
      clearInterval(watchdogInterval);
      clearTimeout(timeoutTimer);
    }

    child.on('close', (exitCode, signal) => {
      cleanup();
      const exitKind = spawnFailed ? 'SPAWN_FAILED'
        : enforcedKill ? 'ENFORCED_KILL'
        : timedOut ? 'TIMEOUT'
        : 'EXITED';
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        status: exitCode,
        signal: signal || null,
        exitKind,
      });
    });
  });
}

function buildPrompt({ plan, skillPaths, schemaPaths, stageInputsPath, driverCommand }) {
  return [
    '这是 E2E 方法正向试验，不是代码开发。只根据当前试验的 START.md、raw/** 与公开 e2e-test 方法工作。',
    `试验身份：host=${plan.hostId} package=${plan.packageId}。不得读取其他试验、期望答案、planning 或 review 文档。`,
    `先完整读取这些公开文件：\n${skillPaths.map(path => `- ${path}`).join('\n')}`,
    '再读取当前目录的 START.md 与 raw/**，独立完成 inspect、assess、design 三个模型工序。',
    '逐 case 终检清单（design 交付前必须逐条满足，可机械检查的部分由驱动器失败关闭）：(1) goal 中每个业务结果都必须落在唯一、可判定的 oracle.criterion 中得到证明；除非来源明确允许多种终态，否则不得用“A 或 B”“可借或分配给下一位”这类二选一写法逃避唯一预期，来源确有多终态时必须写清每个终态各自的判定条件。(2) 每一种故障注入必须分别绑定确定性恢复动作、恢复健康检查与恢复后 oracle；绝不得用“若曾注入故障则恢复”“注入过则恢复”这类以历史是否注入为条件的写法替代，恢复动作必须无条件且可重复（idempotent）。(3) recovery/error case 必须有证明系统回到确定健康态的恢复后 oracle，而非只断言故障被注入。(4) 每个 E2E 候选必须在 e2e_rationale 给出结构化充分理由（逐准则含义、真实协同风险/业务损失、为何 unit/integration/contract 不足），不得只列 C3/C4 标签或重复 path_summary。(5) proof 追溯必须保留 case 的全部 acceptance_criteria（ac_ids），不得只保留第一项。',
    '检查命令合同（verifier 逐条审计，越界即 UNEXPECTED_TOOL 失败关闭）：仅允许对当前工作目录内的 START.md、raw/** 与已读公开方法文件执行只读检查命令（ls、cat、sed -n、find、rg、wc、head、tail、pwd），命令必须显式作用域化到这些输入（如 ls raw、find raw -type f、sed -n 1,200p START.md），且不得带输出重定向。明确禁止裸 pwd、裸 ls 与 `pwd && ls` 一类未显式作用域化的枚举——即使只读也会被 verifier 拒绝；更不得以任何形式（含 ls -la 及其参数变体）枚举试验根、试验根的父目录、work/ 目录、用户主目录或任何超出当前工作目录与公开插件目录的路径。驱动失败后不得改用枚举命令做诊断。',
    `只按以下三个明确 schema 校对输出，不要用 Bash 枚举插件目录：\n${schemaPaths.map(path => `- ${path}`).join('\n')}`,
    `把三个合法 schema 输出写入唯一文件 ${stageInputsPath}，结构严格为 {"inspection":{...},"assessment":{...},"matrix":{...}}。不得复制插件 fixtures，也不得创建辅助脚本或其他文件。`,
    `文件写好后执行这一条 author 驱动命令：\n${driverCommand}`,
    '最多允许调用该命令两次。第一次若且仅若返回 FORWARD_STAGE_INPUT_INVALID，按其中 diagnostics 修正同一个 stage-inputs.json 后再调用一次；任何其他失败立即停止，不得运行诊断命令、读取工作目录、改用直接 Node 调用或继续重试。',
    `驱动成功的确定性证据是：该命令退出码为 0 且 stdout 报告 AUTHOR_PREVIEW_READY。只有在这两个条件同时满足时，才直接返回严格 JSON（驱动成功后不得运行 ls、pwd、find、cat 或任何诊断/确认命令——results/ 文件是否写出由 driver 和 verifier 确定性检查，不是你的责任）：{"status":"AUTHOR_PREVIEW_COMPLETE","hostId":"${plan.hostId}","packageId":"${plan.packageId}","authorResult":"results/author-output.json"}`,
    `驱动失败（非零退出、stdout 报告 BLOCKED 或任何 FORWARD_*/ARTIFACT_* 码）时立即停止，不得运行任何诊断命令，并返回与真实状态一致的严格 JSON：{"status":"AUTHOR_DRIVER_FAILED","hostId":"${plan.hostId}","packageId":"${plan.packageId}","failure":{"code":"<驱动报告的大写下划线码>","diagnostics":[{"code":"<同码>","stage":"<阶段名>","message":"<不超过 240 字的真实诊断>"}]}}。任何情况下不得在驱动未真实成功时输出 AUTHOR_PREVIEW_COMPLETE；你的外层退出码不得掩盖业务失败。`,
    `若无法读取必需的公开方法文件，返回 {"status":"BLOCKED","hostId":"${plan.hostId}","packageId":"${plan.packageId}","failure":{"code":"<大写下划线码>"}}；若原始输入存在无法自行裁决的歧义，返回同构的 {"status":"NEEDS_INPUT",...} 失败 receipt。`,
    '行动纪律（通用，对准思考失控/行动瘫痪根因）：读完所有必需输入后必须立即进入行动——写 stage-inputs、调驱动、产出结构化 receipt。禁止无限 deliberation、禁止反复重读已读文件、禁止产出仅含思考的长文本而不伴随工具调用。时间盒分配：inspect/assess/design 三个模型工序必须在预算的前 40% 时间内完成并写入 stage-inputs.json；剩余预算用于驱动调用和结构化 receipt 产出。若感知到时间不足，必须立即产出当前最优结构化结果（stage-inputs 或 receipt），而非继续思考。不得产出超过 2000 字符的连续思考文本而不伴随工具调用（Write/Bash）。到点即产出，行动优先于完美。',
    '禁止 commit，禁止 git、网络、子智能体和其他业务命令；不得修改 raw、插件或其他目录。',
  ].join('\n\n');
}

/** 构造 Codex exec 参数，projectRoot 和 workRoot 均获得沙箱写授权。 */
export function buildCodexArgs({ receiptSchemaPath, projectRoot, workRoot, prompt }) {
  return [
    'exec', '--json', '--output-schema', receiptSchemaPath, '--sandbox', 'workspace-write',
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-C', projectRoot, '--add-dir', pluginRoot, '--add-dir', workRoot, prompt,
  ];
}

export function buildClaudeArgs({ prompt, receiptSchemaPath, projectRoot, skillPaths, schemaPaths = [], stageInputsPath, driverCommand, workRoot, environment }) {
  const receiptSchema = readFileSync(receiptSchemaPath, 'utf8').trim();
  const dependencyRoots = runtimeDependencyReadRoots();
  const settings = {
    permissions: {
      defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable',
      allow: [
        ...[...skillPaths, ...schemaPaths].map(path => `Read(//${resolve(path).replace(/^\/+/, '')})`),
        `Read(//${resolve(projectRoot).replace(/^\/+/, '')}/**)`,
        `Edit(//${resolve(stageInputsPath).replace(/^\/+/, '')})`,
        `Bash(${driverCommand})`,
        // 宿主仪表化命令形态：Claude Code 会话常在驱动调用后追加 `; echo "EXIT_CODE=$?"`
        // （或无引号变体）以捕获退出码——与 validateForwardTrace 的 normalized 剥离合同
        // 为同一受限后缀。dontAsk 精确匹配下这些形态会被拒绝，导致驱动从未执行而验证器
        // 又按合同期待该调用。此处仅放行**精确**的两个仪表化形态（非前缀通配），不扩大
        // 任意 Bash；verifier 的工具审计（allowed/launcherSequenceValid）保持原严格度。
        `Bash(${driverCommand}; echo "EXIT_CODE=$?")`,
        `Bash(${driverCommand}; echo $?)`,
      ],
      deny: ['NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Bash(git *)'],
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false,
      excludedCommands: [], allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [resolve(projectRoot), resolve(workRoot)],
        denyWrite: dependencyRoots, denyRead: [],
        allowRead: [resolve(projectRoot), ...dependencyRoots],
      },
      credentials: {
        files: ['~/.ssh', '~/.aws', '~/.azure', '~/.config/gcloud', '~/.config/gh', '~/.npmrc', '~/.netrc', '~/.git-credentials', '~/.claude']
          .map(path => ({ path, mode: 'deny' })),
        envVars: protectedEnvironmentNames(environment).map(name => ({ name, mode: 'deny' })),
      },
      network: { allowedDomains: [], deniedDomains: ['*'], allowUnixSockets: [], allowLocalBinding: false },
    },
    autoMemoryEnabled: false, fileCheckpointingEnabled: false, includeGitInstructions: false,
  };
  return [
    '-p', '--output-format', 'stream-json', '--json-schema', receiptSchema,
    '--plugin-dir', pluginRoot, '--tools', 'Read,Write,Bash', '--permission-mode', 'dontAsk',
    '--allowedTools', ...settings.permissions.allow,
    '--disallowedTools', ...settings.permissions.deny,
    '--setting-sources', '', '--settings', JSON.stringify(settings), '--verbose',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', prompt,
  ];
}

function readTar(bytes) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const sizeText = cString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\') || type !== '0' || !Number.isSafeInteger(size) || size < 0) {
      throw coded('FORWARD_PACKAGE_ARCHIVE_INVALID');
    }
    if (files.has(name)) throw coded('FORWARD_PACKAGE_ARCHIVE_INVALID');
    const start = offset + 512;
    const end = start + size;
    if (end > bytes.length) throw coded('FORWARD_PACKAGE_ARCHIVE_INVALID');
    files.set(name, Buffer.from(bytes.subarray(start, end)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function cString(buffer) { return buffer.subarray(0, buffer.indexOf(0) >= 0 ? buffer.indexOf(0) : buffer.length).toString('utf8'); }
function forbiddenContent(content) { return /期望答案|expected answer|\bINSPECT-\d|\bASSESS-\d|\bMATRIX-\d|\bTC-\d|\/(?:Users|home|root)\//i.test(content); }
function protectedInputDigest(projectRoot) { return stableDigest(['START.md', ...listFiles(join(projectRoot, 'raw')).map(path => `raw/${path}`)].map(path => ({ path, digest: digestFile(join(projectRoot, path)) }))); }
function digestWritable(projectRoot, workRoot) { return stableDigest({ project: snapshotTree(projectRoot), work: snapshotTree(workRoot) }); }
function signed(value) { if (!value || typeof value !== 'object') return false; const { digest, ...unsigned } = value; return stableDigest(unsigned) === digest; }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function requireAbsolute(flag) { const item = value(flag); if (!item || !isAbsolute(item)) throw coded('FORWARD_ABSOLUTE_PATH_REQUIRED'); return resolve(item); }
function loadPrepared(root) {
  const plan = JSON.parse(readFileSync(join(root, 'control', 'prepared.json'), 'utf8'));
  const local = JSON.parse(readFileSync(join(root, 'control', 'launch-control.json'), 'utf8'));
  if (!signed(plan)) throw coded('FORWARD_PREPARED_DIGEST_MISMATCH');
  return { plan, local };
}
function verifyPreparedState(root, plan, local) {
  if (plan.trialId !== `${plan.hostId}--${plan.packageId}` || local.pluginRoot !== realpathSync(pluginRoot)) throw coded('FORWARD_PREPARED_IDENTITY_MISMATCH');
  if (protectedInputDigest(local.projectRoot) !== stableDigest(plan.package.files.map(item => ({ path: item.path, digest: item.contentDigest })))) throw coded('FORWARD_INPUT_DRIFT');
  const launcherPath = join(local.projectRoot, plan.launcher?.path || '');
  if (!plan.launcher?.path || !existsSync(launcherPath) || digestFile(launcherPath) !== plan.launcher.contentDigest) throw coded('FORWARD_LAUNCHER_DRIFT');
  if (buildQualificationSubject(pluginRoot).digest !== plan.subject.pluginSubjectDigest) throw coded('FORWARD_PLUGIN_DRIFT');
  const canonicalRoot = realpathSync(root);
  if (!resolve(local.projectRoot).startsWith(`${canonicalRoot}/`) || !resolve(local.workRoot).startsWith(`${canonicalRoot}/`)) throw coded('FORWARD_ROOT_ESCAPE');
}
function hostVersionOf(command) { try { return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { throw coded('FORWARD_HOST_UNAVAILABLE'); } }
export function scrubbedEnvironment(extra) {
  const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
  const provider = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|GCP|VERTEX)_/;
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key) || provider.test(key))),
    // 当前进程已经按 allowlist 重建环境，并在 Claude settings 中再次拒绝
    // credential env。开启 Claude 的 subprocess scrub 会触发
    // allowed_non_write_users hardening，把已显式授权的 launcher 子进程降为
    // 不可写，导致真实工序持久化以 EPERM 失败。
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    E2E_TEST_ARTIFACT_GRAPH_COMMAND: resolveArtifactGraphCommand(),
    ...extra,
  };
}
function resolveArtifactGraphCommand() {
  const explicit = process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND;
  if (explicit && isAbsolute(explicit) && existsSync(explicit)) return realpathSync(explicit);
  // 与 lib/artifact-contract-validation.mjs 的 findArtifactGraphCli 保持一致：
  // 经已声明依赖解析到 artifact-graph CLI 的 realpath，而不是找不存在的 peer 目录。
  try {
    const require = createRequire(join(pluginRoot, 'package.json'));
    const cli = join(dirname(realpathSync(require.resolve('artifact-graph'))), 'cli.js');
    if (existsSync(cli)) return realpathSync(cli);
  } catch { /* 依赖未安装时落入旧 peer 兜底 */ }
  const installedPeer = resolve(pluginRoot, '..', 'artifact-graph', 'dist', 'cli.js');
  return existsSync(installedPeer) ? realpathSync(installedPeer) : '';
}

/**
 * 确定性运行时依赖的只读根闭包。
 *
 * Claude 的 seatbelt 合同把整个 home 目录拒读，只有 allowRead 再开孔。插件符号链接
 * （pnpm 布局）的 realpath 位于仓库根 node_modules 或外部声明依赖仓内，若不再允许，
 * author 驱动子进程会在模块解析和 Artifact Graph CLI 执行时收到 EPERM/ERR_MODULE_NOT_FOUND。
 * 这里只加入已声明依赖的真实根：写模型仍是 projectRoot+workRoot 白名单，
 * credentials 逐条拒绝敏感路径、网络拒绝均不变，不构成沙箱扩大。
 */
export function runtimeDependencyReadRoots() {
  const roots = new Set([resolve(pluginRoot, '..')]);
  const repoNodeModules = resolve(pluginRoot, '..', '..', 'node_modules');
  if (existsSync(repoNodeModules)) {
    try { roots.add(realpathSync(repoNodeModules)); } catch { /* 忽略不可解析根 */ }
  }
  try {
    const require = createRequire(join(pluginRoot, 'package.json'));
    for (const name of ['ajv', 'ajv-formats', 'artifact-graph']) {
      try {
        const packageRoot = packageRootOf(realpathSync(require.resolve(name)));
        if (!packageRoot) continue;
        roots.add(packageRoot);
        // 链接依赖（workspace/外部仓，如 artifact-graph）的运行时依赖位于其所
        // 属仓的 node_modules（pnpm 布局：包内 node_modules 符号链接指向仓级
        // .pnpm store）。只开放包根时，Claude seatbelt 沙箱内该依赖的 CLI 子
        // 进程解析 ajv 等运行时依赖会 ERR_MODULE_NOT_FOUND/EPERM，author 驱动
        // 契约检查失败关闭。这里补开该仓 node_modules 真实根：只读，写白名单
        // （projectRoot+workRoot）、凭据逐条拒绝与网络拒绝均不变，不构成
        // 沙箱扩大。
        const dependencyRepoNodeModules = resolve(packageRoot, '..', '..', 'node_modules');
        if (existsSync(dependencyRepoNodeModules)) {
          try { roots.add(realpathSync(dependencyRepoNodeModules)); } catch { /* 不可解析根忽略 */ }
        }
      } catch { /* 单个依赖解析失败不影响其余根 */ }
    }
  } catch { /* createRequire 失败时保留静态根 */ }
  return [...roots].sort();
}

function packageRootOf(filePath) {
  let dir = dirname(filePath);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}
function protectedEnvironmentNames(environment) {
  const credential = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
  const provider = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|GCP|VERTEX)_/;
  return Object.keys(environment || {}).filter(name => credential.test(name) || provider.test(name)).sort();
}
function coded(code) { return Object.assign(new Error(code), { code }); }
function codeOf(error) { return String(error?.code || error?.message || 'FORWARD_TRIAL_FAILED').match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'FORWARD_TRIAL_FAILED'; }
