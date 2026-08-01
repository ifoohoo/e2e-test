#!/usr/bin/env node

/**
 * browser-extension-runner.mjs
 *
 * 浏览器扩展唯一公开程序入口。只组合现有 M4/M5 内核，不复制、不改写
 * planner、draft、review、commit、execution 或 finalizer。
 *
 * 接受 --request <json> 或 stdin JSON。请求顶层必须精确包含公开动作与所需输入；
 * 未知字段、未知动作、内部阶段名、缺少项目根、缺少/跨服务/撤销的 ExtensionBinding
 * 必须在任何写入、命令、进程或网络副作用前失败。
 *
 * 公开动作：
 *   implement.preview  — 预览 implement 计划，零写入
 *   implement.commit   — 提交 implement（需用户确认）
 *   execute.preview    — 预览执行计划，零写入
 *   execute.run        — 执行测试（需用户确认）
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExtensionBinding } from './lib/browser-extension-binding.mjs';
import { stableDigest } from './lib/digest.mjs';

// ─── 插件根目录 ───

const pluginRoot = join(import.meta.dirname, '..');

// ─── provider 输入绑定 ───

/**
 * 将不可信 provider payload 绑定到受信 request.requestDigest 并复算 resultDigest。
 *
 * caller 不能预知 runner 内部生成的 requestDigest，因此可以提交不含
 * requestDigest/resultDigest 的 payload。runner 在同进程生成 CodeDraftRequest
 * 后，把该不可信 payload 绑定到真实摘要。
 *
 * 若 caller 显式提交了摘要，则必须精确匹配，不能被静默覆盖。
 */
function rebindProviderResult(untrusted, request) {
  if (!untrusted || typeof untrusted !== 'object') return null;
  if (typeof untrusted.contract !== 'string' ||
      typeof untrusted.provider !== 'object' ||
      !Array.isArray(untrusted.drafts)) return null;

  const boundRequestDigest = request.requestDigest;
  const resultUnsigned = {
    contract: untrusted.contract,
    requestDigest: boundRequestDigest,
    provider: untrusted.provider,
    drafts: untrusted.drafts,
  };
  const boundResultDigest = stableDigest(resultUnsigned);

  // caller 显式提交摘要时必须精确匹配
  if (untrusted.requestDigest !== undefined &&
      untrusted.requestDigest !== boundRequestDigest) return null;
  if (untrusted.resultDigest !== undefined &&
      untrusted.resultDigest !== boundResultDigest) return null;

  return {
    ...resultUnsigned,
    resultDigest: boundResultDigest,
  };
}

// ─── 公开动作集合 ───

const PUBLIC_ACTIONS = new Set([
  'implement.preview',
  'implement.commit',
  'execute.preview',
  'execute.run',
]);

// ─── 内部阶段名（禁止暴露） ───

const INTERNAL_STAGE_NAMES = new Set([
  'planner', 'planner.run', 'planner.plan',
  'draft', 'draft.run', 'draft.request', 'draft.preview',
  'review', 'review.run', 'review.code',
  'repair', 'repair.run', 'repair.code',
  'commit', 'commit.run', 'commit.preview',
  'execution', 'execution.run', 'execution.plan',
  'finalizer', 'finalizer.run',
  'inspect', 'prepare', 'generate', 'validate', 'reconcile',
]);

// ─── 已知请求字段（session 与单次模式共享） ───

const KNOWN_REQUEST_FIELDS = new Set(['action', 'projectRoot', 'binding', 'inputs']);

// ─── 服务身份 ───

const IMPLEMENT_SERVICE = 'artifact.e2e-test.browser.implement';
const EXECUTE_SERVICE = 'artifact.e2e-test.browser.execute';

// ─── 输入解析 ───

const args = process.argv.slice(2);
const requestIndex = args.indexOf('--request');
const requestPath = requestIndex >= 0 ? args[requestIndex + 1] : null;
const jsonMode = args.includes('--json');
const sessionMode = args.includes('--session');

// ─── session 模式 ───

if (sessionMode) {
  await runSession();
  process.exit(0);
}

// ─── 单次执行模式 ───

let rawInput;

if (requestPath) {
  try {
    rawInput = readFileSync(requestPath, 'utf8');
  } catch {
    emitFailure('REQUEST_FILE_UNREADABLE', ['无法读取 request 文件']);
  }
} else {
  // 从 stdin 读取
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  rawInput = Buffer.concat(chunks).toString('utf8');
}

if (!rawInput || rawInput.trim().length === 0) {
  emitFailure('REQUEST_REQUIRED', ['缺少 --request <json> 或 stdin 输入']);
}

// ─── 请求解析与基础验证 ───

let request;
try {
  request = JSON.parse(rawInput);
} catch {
  emitFailure('INVALID_REQUEST', ['JSON 解析失败']);
}

if (!request || typeof request !== 'object' || Array.isArray(request)) {
  emitFailure('INVALID_REQUEST', ['请求必须是 JSON 对象']);
}

// ─── 动作验证（必须在任何副作用前） ───

const action = typeof request.action === 'string' ? request.action.trim() : '';

if (!action) {
  emitFailure('ACTION_REQUIRED', ['请求缺少 action 字段']);
}

// 检查是否为内部阶段名
if (INTERNAL_STAGE_NAMES.has(action)) {
  emitFailure('INTERNAL_STAGE_REJECTED', [
    `动作 "${action}" 是内部阶段名，不作为公开入口暴露`,
  ]);
}

// 检查是否为已知公开动作
if (!PUBLIC_ACTIONS.has(action)) {
  emitFailure('UNKNOWN_ACTION', [
    `未知动作 "${action}"；合法动作：${[...PUBLIC_ACTIONS].join(', ')}`,
  ]);
}

// ─── 未知字段拒绝 ───

const unknownFields = Object.keys(request).filter(k => !KNOWN_REQUEST_FIELDS.has(k));
if (unknownFields.length > 0) {
  emitFailure('UNKNOWN_FIELDS', [
    `请求包含未知字段：${unknownFields.join(', ')}`,
  ]);
}

// ─── projectRoot 验证 ───

const projectRoot = typeof request.projectRoot === 'string' ? request.projectRoot : '';

if (!projectRoot) {
  emitFailure('PROJECT_ROOT_REQUIRED', ['请求缺少 projectRoot']);
}

if (!isAbsolute(projectRoot)) {
  emitFailure('PROJECT_ROOT_INVALID', ['projectRoot 必须是绝对路径']);
}

if (!existsSync(projectRoot)) {
  emitFailure('PROJECT_ROOT_NOT_FOUND', [`projectRoot 不存在：${projectRoot}`]);
}

let resolvedRoot;
try {
  resolvedRoot = realpathSync(projectRoot);
} catch {
  emitFailure('PROJECT_ROOT_INVALID', ['projectRoot 无法解析']);
}

// ─── ExtensionBinding 验证 ───

const binding = request.binding;

if (!binding || typeof binding !== 'object') {
  emitFailure('BINDING_REQUIRED', ['请求缺少 ExtensionBinding']);
}

// 确定当前动作所需的服务
const isImplement = action.startsWith('implement.');
const expectedService = isImplement ? IMPLEMENT_SERVICE : EXECUTE_SERVICE;

// ─── ExtensionBinding 完整验证（统一交给 production validator） ───

const packageVersion = JSON.parse(
  readFileSync(join(pluginRoot, 'package.json'), 'utf8'),
).version;

const bindingResult = validateExtensionBinding(binding, {
  expectedService,
  projectRoot: resolvedRoot,
  packageVersion,
});
if (!bindingResult.ok) {
  emitFailure(bindingResult.code, bindingResult.violations);
}

// ─── 动作分发（仅在所有验证通过后） ───

if (isImplement) {
  await handleImplement(action, resolvedRoot, request);
} else {
  await handleExecute(action, resolvedRoot, request);
}

// ─── Implement 处理 ───

async function handleImplement(act, root, req) {
  // 动态导入 M4 内核（仅在验证通过后）
  const { prepareImplementationPlan } = await import('./lib/browser-implementation-planner.mjs');

  const inputs = req.inputs;

  if (!inputs || typeof inputs !== 'object') {
    emitFailure('IMPLEMENT_INPUTS_REQUIRED', [
      'implement 动作需要 inputs 字段（包含 refs、profile、now）',
    ]);
  }

  if (act === 'implement.preview') {
    const planResult = prepareImplementationPlan({
      pluginRoot,
      projectRoot: root,
      refs: inputs.refs,
      profile: inputs.profile,
      now: inputs.now || Date.now(),
    });

    if (!planResult.ok) {
      emitFailure(planResult.code, planResult.violations);
    }

    emitSuccess({
      status: 'PREVIEW_READY',
      code: 'IMPLEMENT_PREVIEW_READY',
      action: act,
      plan: planResult.plan,
      approval: planResult.approval,
      inputDigests: planResult.inputDigests,
      writesPerformed: 0,
    });
  } else if (act === 'implement.commit') {
    // Node 2.1 薄入口：commit 需要完整 M4 链，暂不支持直接调用
    emitFailure('IMPLEMENT_COMMIT_NOT_YET', [
      'implement.commit 需要完整的 M4 链逐步执行，Node 2.1 薄入口暂不支持直接调用',
    ]);
  }
}

// ─── Execute 处理 ───

async function handleExecute(act, root, req) {
  const { prepareExecutionPlan } = await import('./lib/browser-execution.mjs');

  const inputs = req.inputs;

  if (!inputs || typeof inputs !== 'object') {
    emitFailure('EXECUTE_INPUTS_REQUIRED', [
      'execute 动作需要 inputs 字段（包含 commitResult 等）',
    ]);
  }

  if (act === 'execute.preview') {
    const planResult = prepareExecutionPlan({
      commitResult: inputs.commitResult,
      baseURL: inputs.baseURL,
      readinessURL: inputs.readinessURL,
      allowlist: inputs.allowlist,
      envWhitelist: inputs.envWhitelist,
      secretHandles: inputs.secretHandles,
      timeouts: inputs.timeouts,
      workers: inputs.workers,
      resources: inputs.resources,
      browser: inputs.browser,
      isolation: inputs.isolation,
      artifactPolicy: inputs.artifactPolicy,
    });

    if (!planResult.ok) {
      emitFailure(planResult.code, planResult.violations);
    }

    emitSuccess({
      status: 'EXECUTION_PLAN_READY',
      code: 'EXECUTE_PREVIEW_READY',
      action: act,
      plan: planResult.plan,
      writesPerformed: 0,
    });
  } else if (act === 'execute.run') {
    // Node 2.1 薄入口：run 需要完整 M5 链，暂不支持直接调用
    emitFailure('EXECUTE_RUN_NOT_YET', [
      'execute.run 需要完整的 M5 链和执行控制器，Node 2.1 薄入口暂不支持直接调用',
    ]);
  }
}

// ─── 输出函数 ───

function emitSuccess(value) {
  process.stdout.write(`${JSON.stringify(value, null, jsonMode ? 2 : 0)}\n`);
  process.exit(0);
}

function emitFailure(code, violations = []) {
  const output = {
    status: 'BLOCKED',
    code,
    violations: [...new Set(violations.map(String))],
  };
  process.stdout.write(`${JSON.stringify(output, null, jsonMode ? 2 : 0)}\n`);
  process.exit(1);
}

// ─── Session 模式 ───

async function runSession() {
  // 动态导入 M4/M5 内核
  const { prepareImplementationPlan } = await import('./lib/browser-implementation-planner.mjs');
  const { prepareCodeDraftRequest, acceptCodeDraftPreview } = await import('./lib/browser-code-draft.mjs');
  const { reviewCodeDraft } = await import('./lib/browser-code-review.mjs');
  const { prepareImplementationCommitPreview, createImplementationCommitController } = await import('./lib/browser-implementation-commit.mjs');
  const { prepareExecutionPlan, createBrowserExecutionController } = await import('./lib/browser-execution.mjs');
  const executionHost = await import('./lib/browser-execution-host.mjs');

  // session 状态：存储受信对象
  const sessionState = {
    planningPreview: null,
    draftRequest: null,
    previewBindingDigest: null,
    draftPreview: null,
    review: null,
    commitPreview: null,
    commitController: null,
    commitResult: null,
    lockedRoot: null,
    executionPlan: null,
    previewExecuteBindingDigest: null,
  };

  // 逐行流式读取 stdin，收到一行即处理一行
  for await (const line of readLineStream(process.stdin)) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      emitSessionError('INVALID_REQUEST', ['JSON 解析失败']);
      continue;
    }

    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      emitSessionError('INVALID_REQUEST', ['请求必须是 JSON 对象']);
      continue;
    }

    const action = typeof request.action === 'string' ? request.action.trim() : '';
    if (!action) {
      emitSessionError('ACTION_REQUIRED', ['请求缺少 action 字段']);
      continue;
    }

    if (INTERNAL_STAGE_NAMES.has(action)) {
      emitSessionError('INTERNAL_STAGE_REJECTED', [
        `动作 "${action}" 是内部阶段名，不作为公开入口暴露`,
      ]);
      continue;
    }

    if (!PUBLIC_ACTIONS.has(action)) {
      emitSessionError('UNKNOWN_ACTION', [
        `未知动作 "${action}"；合法动作：${[...PUBLIC_ACTIONS].join(', ')}`,
      ]);
      continue;
    }

    // 未知顶层字段拒绝（与单次模式一致）
    const sessionUnknownFields = Object.keys(request).filter(k => !KNOWN_REQUEST_FIELDS.has(k));
    if (sessionUnknownFields.length > 0) {
      emitSessionError('UNKNOWN_FIELDS', [
        `请求包含未知字段：${sessionUnknownFields.join(', ')}`,
      ]);
      continue;
    }

    // 验证 projectRoot
    const projectRoot = typeof request.projectRoot === 'string' ? request.projectRoot : '';
    if (!projectRoot) {
      emitSessionError('PROJECT_ROOT_REQUIRED', ['请求缺少 projectRoot']);
      continue;
    }

    if (!isAbsolute(projectRoot)) {
      emitSessionError('PROJECT_ROOT_INVALID', ['projectRoot 必须是绝对路径']);
      continue;
    }

    if (!existsSync(projectRoot)) {
      emitSessionError('PROJECT_ROOT_NOT_FOUND', [`projectRoot 不存在：${projectRoot}`]);
      continue;
    }

    // 验证 binding
    const binding = request.binding;
    if (!binding || typeof binding !== 'object') {
      emitSessionError('BINDING_REQUIRED', ['请求缺少 ExtensionBinding']);
      continue;
    }

    const isImplement = action.startsWith('implement.');
    const expectedService = isImplement ? IMPLEMENT_SERVICE : EXECUTE_SERVICE;

    // 解析 projectRoot 真实路径（与单次模式一致）
    let resolvedRoot;
    try {
      resolvedRoot = realpathSync(projectRoot);
    } catch {
      emitSessionError('PROJECT_ROOT_INVALID', ['projectRoot 无法解析']);
      continue;
    }

    // 项目根锁定：首次成功 implement.preview 后锁定，后续跨项目根请求在 binding 验证前失败
    if (sessionState.lockedRoot && resolvedRoot !== sessionState.lockedRoot) {
      emitSessionError('SESSION_PROJECT_ROOT_MISMATCH', [
        `session 已锁定项目根 ${sessionState.lockedRoot}，请求的项目根 ${resolvedRoot} 不匹配`,
      ]);
      continue;
    }

    // ExtensionBinding 完整验证（与单次模式共享同一 production validator）
    const sessionPackageVersion = JSON.parse(
      readFileSync(join(pluginRoot, 'package.json'), 'utf8'),
    ).version;

    const sessionBindingResult = validateExtensionBinding(binding, {
      expectedService,
      projectRoot: resolvedRoot,
      packageVersion: sessionPackageVersion,
    });
    if (!sessionBindingResult.ok) {
      emitSessionError(sessionBindingResult.code, sessionBindingResult.violations);
      continue;
    }

    // 执行动作
    try {
      if (isImplement) {
        await handleImplementSession(action, projectRoot, resolvedRoot, request, sessionState, sessionPackageVersion, {
          prepareImplementationPlan,
          prepareCodeDraftRequest,
          acceptCodeDraftPreview,
          reviewCodeDraft,
          prepareImplementationCommitPreview,
          createImplementationCommitController,
        });
      } else {
        await handleExecuteSession(action, projectRoot, resolvedRoot, request, sessionState, sessionPackageVersion, {
          prepareExecutionPlan,
          createBrowserExecutionController,
          executionHost,
        });
      }
    } catch (error) {
      emitSessionError('SESSION_INTERNAL_ERROR', [error.message]);
    }
  }
}

function emitSessionResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, jsonMode ? 2 : 0)}\n`);
}

function emitSessionError(code, violations = []) {
  const output = {
    status: 'BLOCKED',
    code,
    violations: [...new Set(violations.map(String))],
  };
  process.stdout.write(`${JSON.stringify(output, null, jsonMode ? 2 : 0)}\n`);
}

async function* readLineStream(readable) {
  let buffer = '';
  for await (const chunk of readable) {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
    }
  }
  if (buffer.trim().length > 0) {
    yield buffer;
  }
}

async function handleImplementSession(act, root, resolvedRoot, req, state, pkgVersion, kernels) {
  const inputs = req.inputs;
  if (!inputs || typeof inputs !== 'object') {
    emitSessionError('IMPLEMENT_INPUTS_REQUIRED', [
      'implement 动作需要 inputs 字段（包含 refs、profile、now、providerResult）',
    ]);
    return;
  }

  if (act === 'implement.preview') {
    // implement.preview 要求 inputs.providerResult，执行完整 M4 链
    if (!inputs.providerResult) {
      emitSessionError('IMPLEMENT_PROVIDER_RESULT_REQUIRED', [
        'implement.preview 需要 inputs.providerResult',
      ]);
      return;
    }

    const planningInput = {
      pluginRoot,
      projectRoot: root,
      refs: inputs.refs,
      profile: inputs.profile,
      now: inputs.now || Date.now(),
    };

    // M4-A: planner
    const planResult = kernels.prepareImplementationPlan(planningInput);
    if (!planResult.ok) {
      emitSessionError(planResult.code, planResult.violations);
      return;
    }
    state.planningPreview = planResult;

    // implement-specific binding scope 验证
    // 多 case 共用同一文件时按文件集合去重
    const planWritePaths = [...new Set(
      planResult.plan.cases.flatMap(item => item.allowedWritePaths),
    )].sort();
    const implScopeResult = validateExtensionBinding(req.binding, {
      projectRoot: resolvedRoot,
      packageVersion: pkgVersion,
      expectedSubject: planResult.plan.subjectDigest,
      expectedWritePaths: planWritePaths,
    });
    if (!implScopeResult.ok) {
      emitSessionError(implScopeResult.code, implScopeResult.violations);
      return;
    }

    // M4-B: draft request
    const draftRequestResult = kernels.prepareCodeDraftRequest({
      planningInput,
    });
    if (!draftRequestResult.ok) {
      emitSessionError(draftRequestResult.code, draftRequestResult.violations);
      return;
    }
    state.draftRequest = draftRequestResult.request;

    // M4-B: provider 输入绑定 — caller 不能预知 requestDigest，runner 在此绑定
    const boundProviderResult = rebindProviderResult(
      inputs.providerResult,
      draftRequestResult.request,
    );
    if (!boundProviderResult) {
      emitSessionError('PROVIDER_RESULT_BINDING_FAILED', [
        'provider payload 无法绑定到受信 request；contract/drafts 格式无效或显式摘要不匹配',
      ]);
      return;
    }

    // M4-B: accept draft preview（使用已绑定的 providerResult）
    const draftPreview = kernels.acceptCodeDraftPreview({
      request: draftRequestResult.request,
      providerResult: boundProviderResult,
    });
    if (!draftPreview.ok) {
      emitSessionError(draftPreview.code, draftPreview.violations);
      return;
    }
    state.draftPreview = draftPreview;

    // M4-C: code review
    const reviewed = kernels.reviewCodeDraft({
      request: draftRequestResult.request,
      preview: draftPreview,
    });
    if (!reviewed.ok) {
      emitSessionError(reviewed.code, reviewed.violations);
      return;
    }
    state.review = reviewed.review;

    // 只有 review PASS 才生成 commit preview
    if (reviewed.status !== 'PASS') {
      emitSessionError('CODE_REVIEW_NOT_PASS', [
        `代码审查未通过：${reviewed.status}`,
      ]);
      return;
    }

    // M4-D: commit preview
    const commitPreviewResult = kernels.prepareImplementationCommitPreview({
      review: reviewed.review,
    });
    if (!commitPreviewResult.ok) {
      emitSessionError(commitPreviewResult.code, commitPreviewResult.violations);
      return;
    }
    state.commitPreview = commitPreviewResult.commitPreview;

    // 首次成功 implement.preview 后锁定项目根和 binding digest
    if (!state.lockedRoot) {
      state.lockedRoot = resolvedRoot;
    }
    state.previewBindingDigest = req.binding.bindingDigest;

    emitSessionResult({
      status: 'IMPLEMENT_PREVIEW_READY',
      code: 'IMPLEMENT_PREVIEW_READY',
      action: act,
      commitPreview: commitPreviewResult.commitPreview,
      previewDigest: commitPreviewResult.commitPreview.previewDigest,
      plannedWrites: commitPreviewResult.commitPreview.plannedWrites.map(item => item.file),
      writesPerformed: 0,
    });
  } else if (act === 'implement.commit') {
    if (!inputs.previewDigest) {
      emitSessionError('IMPLEMENT_COMMIT_PREVIEW_DIGEST_REQUIRED', [
        'implement.commit 需要 inputs.previewDigest',
      ]);
      return;
    }

    if (!state.commitPreview) {
      emitSessionError('IMPLEMENT_COMMIT_NO_PREVIEW', [
        'session 中没有 commit preview，请先调用 implement.preview',
      ]);
      return;
    }

    // 验证 preview digest
    if (state.commitPreview.previewDigest !== inputs.previewDigest) {
      emitSessionError('IMPLEMENT_COMMIT_PREVIEW_DIGEST_MISMATCH', [
        'preview digest 不匹配',
      ]);
      return;
    }

    // 验证 binding 未漂移（commit binding digest 必须与 preview 时一致）
    if (state.previewBindingDigest && req.binding.bindingDigest !== state.previewBindingDigest) {
      emitSessionError('BINDING_DRIFT', [
        'binding 已漂移：commit binding digest 与 preview 时不一致',
      ]);
      return;
    }

    // runner 私有安全随机源产生 authority secret，禁止固定全零密钥
    const { randomBytes } = await import('node:crypto');
    const authoritySecret = randomBytes(32);
    const keyId = `session-key-${randomBytes(8).toString('hex')}`;

    const controller = kernels.createImplementationCommitController({
      projectRoot: root,
      authoritySecret,
      keyId,
    });
    state.commitController = controller;

    // 签发 handle
    const handleResult = controller.issue(state.commitPreview);
    if (!handleResult.ok) {
      emitSessionError(handleResult.code, handleResult.violations);
      return;
    }

    // 执行 commit：把原始 M4 controller 的 handle/secret 交回同一 controller
    const commitResult = controller.commit({
      commitPreview: state.commitPreview,
      handle: handleResult.handle,
      authorizationSecret: handleResult.authorizationSecret,
    });

    if (!commitResult.ok) {
      emitSessionError(commitResult.code, commitResult.violations);
      return;
    }

    // 保存原始 commitResult
    state.commitResult = commitResult;

    emitSessionResult({
      status: 'IMPLEMENT_COMMIT_READY_TO_RUN',
      code: 'IMPLEMENTATION_COMMIT_READY_TO_RUN',
      action: act,
      bindingManifest: commitResult.bindingManifest,
      validationReceipt: commitResult.validationReceipt,
      writesPerformed: commitResult.writesPerformed,
    });
  }
}

async function handleExecuteSession(act, root, resolvedRoot, req, state, pkgVersion, kernels) {
  const inputs = req.inputs;
  if (!inputs || typeof inputs !== 'object') {
    emitSessionError('EXECUTE_INPUTS_REQUIRED', [
      'execute 动作需要 inputs 字段',
    ]);
    return;
  }

  if (act === 'execute.preview') {
    // execute.preview 要求独立 execute binding、同一真实项目根
    if (!state.commitResult) {
      emitSessionError('EXECUTE_PREVIEW_NO_COMMIT_RESULT', [
        'session 中没有 commit result，请先完成 implement.commit',
      ]);
      return;
    }

    // execute-specific binding scope 验证
    const execScopeResult = validateExtensionBinding(req.binding, {
      projectRoot: resolvedRoot,
      packageVersion: pkgVersion,
      expectedSubject: state.commitResult.bindingManifest.bindingDigest,
      expectedWritePaths: ['.artifact-graph/runs/e2e-test'],
    });
    if (!execScopeResult.ok) {
      emitSessionError(execScopeResult.code, execScopeResult.violations);
      return;
    }

    // 只把 session 中的原始 commitResult 传给 M5 prepareExecutionPlan
    // 请求不得注入 commitResult
    const planResult = kernels.prepareExecutionPlan({
      commitResult: state.commitResult,
      baseURL: inputs.baseURL,
      readinessURL: inputs.readinessURL,
      allowlist: inputs.allowlist,
      envWhitelist: inputs.envWhitelist,
      secretHandles: inputs.secretHandles,
      timeouts: inputs.timeouts,
      workers: inputs.workers,
      resources: inputs.resources,
      browser: inputs.browser,
      isolation: inputs.isolation,
      artifactPolicy: inputs.artifactPolicy,
    });

    if (!planResult.ok) {
      emitSessionError(planResult.code, planResult.violations);
      return;
    }

    // 保存原始 ExecutionPlan 和 binding digest 供 execute.run 验证
    state.executionPlan = planResult.plan;
    state.previewExecuteBindingDigest = req.binding.bindingDigest;

    emitSessionResult({
      status: 'EXECUTION_PLAN_READY',
      code: 'EXECUTE_PREVIEW_READY',
      action: act,
      plan: planResult.plan,
      writesPerformed: 0,
    });
  } else if (act === 'execute.run') {
    // execute.run 需要同一 session 的 ExecutionPlan
    if (!state.executionPlan) {
      emitSessionError('EXECUTE_RUN_NO_PLAN', [
        'session 中没有 execution plan，请先调用 execute.preview',
      ]);
      return;
    }

    // 要求 caller 回传精确 planDigest 作为本次执行授权确认
    if (!inputs.planDigest || inputs.planDigest !== state.executionPlan.planDigest) {
      emitSessionError('EXECUTE_PLAN_DIGEST_MISMATCH', [
        'inputs.planDigest 必须与 execute.preview 返回的 planDigest 精确匹配',
      ]);
      return;
    }

    // execute binding 必须与 preview 时相同，漂移在副作用前失败
    if (state.previewExecuteBindingDigest &&
        req.binding.bindingDigest !== state.previewExecuteBindingDigest) {
      emitSessionError('BINDING_DRIFT', [
        'execute binding 已漂移：run binding digest 与 preview 时不一致',
      ]);
      return;
    }

    // runner 私有安全随机源产生 authority secret
    const { randomBytes } = await import('node:crypto');
    const authoritySecret = randomBytes(32);
    const keyId = `exec-key-${randomBytes(8).toString('hex')}`;

    // 创建受信执行控制器：plan.isolation.executor === 'docker' 时改用
    // docker 隔离宿主（--network none 容器），否则沿用既有本机进程宿主；
    // 两种路径的 networkObserver 都复用本机宿主实现（trace.zip 经挂载卷落盘）
    let controllerOptions = {
      projectRoot: root,
      authoritySecret,
      keyId,
      readinessProbe: kernels.executionHost.readinessProbe,
      networkObserver: kernels.executionHost.networkObserver,
      resourceObserver: kernels.executionHost.resourceObserver,
      runner: kernels.executionHost.playwrightRunner,
      teardownInspector: kernels.executionHost.teardownInspector,
      browserVersionProbe: kernels.executionHost.browserVersionProbe,
      lifecycleAdapter: kernels.executionHost.lifecycleAdapter,
    };
    if (state.executionPlan.isolation?.executor === 'docker') {
      const dockerHost = await import('./lib/browser-execution-docker-host.mjs');
      // daemon 不可用或镜像缺失：在任何执行副作用前失败关闭，禁止拉取
      const availability = dockerHost.checkDockerIsolation(state.executionPlan.isolation);
      if (!availability.ok) {
        emitSessionError('M5_ISOLATION_UNAVAILABLE', [
          `docker 隔离执行器不可用: ${availability.error}`,
        ]);
        return;
      }
      dockerHost.configureDockerExecutor({
        isolation: state.executionPlan.isolation,
        resources: state.executionPlan.resources,
      });
      controllerOptions = {
        ...controllerOptions,
        readinessProbe: dockerHost.dockerReadinessProbe,
        resourceObserver: dockerHost.dockerResourceObserver,
        runner: dockerHost.dockerRunner,
        teardownInspector: dockerHost.dockerTeardownInspector,
        browserVersionProbe: dockerHost.dockerBrowserVersionProbe,
        lifecycleAdapter: dockerHost.dockerLifecycleAdapter,
      };
    }
    const controller = kernels.createBrowserExecutionController(controllerOptions);

    // 签发一次性 execute handle
    const handleResult = controller.issue(state.executionPlan);
    if (!handleResult.ok) {
      emitSessionError(handleResult.code, handleResult.violations);
      return;
    }

    // 执行：消费同一 session 的 ExecutionPlan
    const executeResult = controller.execute({
      plan: state.executionPlan,
      handle: handleResult.handle,
      authorizationSecret: handleResult.authorizationSecret,
    });

    if (!executeResult.ok) {
      emitSessionResult({
        status: 'BLOCKED',
        code: executeResult.code,
        violations: executeResult.violations,
        outputRoot: executeResult.outputRoot || null,
        teardown: executeResult.teardown || null,
        // docker 宿主发布阶段回滚状态透传（Attempt 008；无发布阶段失败时为 null）
        rollback: executeResult.rollback || null,
      });
      return;
    }

    // 只有 private finalizer 推导为 SUCCEEDED 才返回 EXECUTION_SUCCEEDED
    emitSessionResult({
      status: executeResult.status,
      code: executeResult.code,
      action: act,
      planDigest: executeResult.planDigest,
      raw: executeResult.raw,
      networkAudit: executeResult.networkAudit,
      resourceExecution: executeResult.resourceExecution,
      teardown: executeResult.teardown,
      freshness: executeResult.freshness,
      canonical: executeResult.canonical,
      outputRoot: executeResult.outputRoot,
    });
  }
}
