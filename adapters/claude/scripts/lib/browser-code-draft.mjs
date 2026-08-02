/**
 * M4-B provider-neutral Playwright 草稿请求与接受器。
 *
 * provider 返回值始终是不可信数据。本模块只产生内存 preview，不写文件、不运行
 * 命令、不联网，也不产生 commit capability 或“测试通过”结论。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import ts from '../runtime-deps/typescript-bundle.mjs';

import { validateArtifactContract } from './artifact-contract-validation.mjs';
import { prepareImplementationPlan } from './browser-implementation-planner.mjs';
import { stableDigest } from './digest.mjs';
import { validateSchema } from './schema-validation.mjs';

const REQUEST_CONTRACT = 'e2e-test/code-draft-request/v1';
const RESULT_CONTRACT = 'e2e-test/code-draft-provider-result/v1';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const LOCATOR_APPROACHES = Object.freeze(['role', 'test-id']);
const WAIT_KINDS = Object.freeze(['poll', 'event', 'state']);
const FORBIDDEN_PATTERNS = Object.freeze([
  'css-selector-chain',
  'fixed-wait',
  'skip',
  'fixme',
  'arbitrary-retry',
  'dynamic-code-execution',
  'command-or-filesystem-access',
  'network-access',
  'secret-or-absolute-path-leak',
]);
const TRUSTED_REQUESTS = new WeakMap();
const TRUSTED_PREVIEWS = new WeakMap();

export const DRAFT_FAILURE_CODES = Object.freeze({
  M4_DRAFT_INPUT_REQUIRED: 'M4_DRAFT_INPUT_REQUIRED',
  M4_DRAFT_PLANNING_HANDOFF_INVALID: 'M4_DRAFT_PLANNING_HANDOFF_INVALID',
  M4_DRAFT_PLAN_INVALID: 'M4_DRAFT_PLAN_INVALID',
  M4_DRAFT_ARTIFACT_INVALID: 'M4_DRAFT_ARTIFACT_INVALID',
  M4_DRAFT_SOURCE_DRIFT: 'M4_DRAFT_SOURCE_DRIFT',
  M4_DRAFT_REQUEST_INVALID: 'M4_DRAFT_REQUEST_INVALID',
  M4_DRAFT_RESULT_INVALID: 'M4_DRAFT_RESULT_INVALID',
  M4_DRAFT_REQUEST_MISMATCH: 'M4_DRAFT_REQUEST_MISMATCH',
  M4_DRAFT_CASE_SET_MISMATCH: 'M4_DRAFT_CASE_SET_MISMATCH',
  M4_DRAFT_CASE_DRIFT: 'M4_DRAFT_CASE_DRIFT',
  M4_DRAFT_SOURCE_UNSAFE: 'M4_DRAFT_SOURCE_UNSAFE',
  M4_DRAFT_POLICY_VIOLATION: 'M4_DRAFT_POLICY_VIOLATION',
  M4_DRAFT_GENERATED_TEST_INVALID: 'M4_DRAFT_GENERATED_TEST_INVALID',
});

function failure(code, violations) {
  return {
    ok: false,
    status: 'BLOCKED',
    code,
    violations: [...new Set((violations || []).map(String))],
    request: null,
    previews: [],
    generatedTests: [],
    writesPerformed: 0,
  };
}

function unsigned(value, digestField) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => key !== digestField),
  );
}

function selfDigestMatches(value, digestField) {
  return value && DIGEST_RE.test(value[digestField] || '') &&
    stableDigest(unsigned(value, digestField)) === value[digestField];
}

function contentDigest(source) {
  return `sha256:${createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')}`;
}

function rawDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeRelativePath(ref) {
  if (typeof ref !== 'string' || ref.length === 0 ||
      isAbsolute(ref) || ref.startsWith('/') ||
      ref.includes('\\') || ref.includes('\0')) return false;
  return ref.split('/').every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..');
}

function readBoundJson(projectRoot, ref, expectedDigest) {
  if (typeof projectRoot !== 'string' ||
      !safeRelativePath(ref) ||
      !DIGEST_RE.test(expectedDigest || '')) return null;
  try {
    const root = realpathSync(projectRoot);
    let current = root;
    for (const segment of ref.split('/')) {
      current = resolve(current, segment);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    if (!existsSync(current) || !lstatSync(current).isFile()) return null;
    const target = realpathSync(current);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const bytes = readFileSync(target);
    if (rawDigest(bytes) !== expectedDigest) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function schemaCheck(pluginRoot, schemaFile, value, label) {
  try {
    const result = validateSchema(pluginRoot, schemaFile, value);
    return result.valid
      ? { ok: true }
      : failure(
        DRAFT_FAILURE_CODES.M4_DRAFT_RESULT_INVALID,
        result.errors.map(error => `${label}:${error.instancePath || '/'}:${error.keyword}`),
      );
  } catch {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_RESULT_INVALID,
      [`schema 不可用:${label}`],
    );
  }
}

function exactCaseSet(expectedCases, actualCases) {
  if (!Array.isArray(expectedCases) || !Array.isArray(actualCases)) return false;
  const expected = expectedCases.map(item => item.caseId);
  const actual = actualCases.map(item => item.caseId);
  if (new Set(expected).size !== expected.length ||
      new Set(actual).size !== actual.length ||
      expected.length !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every(caseId => actualSet.has(caseId));
}

function safeReference(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\/#]/).includes('..');
}

function makeRequestCase(planCase, matrixCase, artifactCase) {
  const fixtureDigest = stableDigest({
    data_identity: matrixCase.data_identity,
    environment: matrixCase.environment,
    cleanup: matrixCase.cleanup,
  });
  const assertionDigest = stableDigest({
    matrixOracle: matrixCase.oracle,
    artifactOracles: artifactCase.oracles,
  });
  if (fixtureDigest !== planCase.fixtureDigest ||
      assertionDigest !== planCase.assertionDigest) {
    return null;
  }
  return {
    caseId: planCase.caseId,
    file: planCase.targetFile,
    title: planCase.title,
    fixtureDigest,
    assertionDigest,
    businessOracleRef: planCase.businessOracleRef,
    actor: matrixCase.actor_goal.actor,
    goal: matrixCase.actor_goal.goal,
    task: matrixCase.actor_goal.task,
    steps: structuredClone(matrixCase.path.steps),
    oracle: {
      observable: matrixCase.oracle.observable,
      criterion: matrixCase.oracle.criterion,
      negativeCheck: matrixCase.oracle.negative_check,
      timeoutMs: matrixCase.oracle.timeout_ms,
    },
    fixture: {
      testData: structuredClone(matrixCase.data_identity.test_data),
      identities: structuredClone(matrixCase.data_identity.identities),
      isolation: matrixCase.data_identity.isolation,
      setup: structuredClone(matrixCase.environment.setup),
      cleanup: structuredClone(matrixCase.cleanup.cleanup_steps),
      failureCleanup: structuredClone(matrixCase.cleanup.failure_cleanup),
    },
  };
}

function validPlanningHandoff(planningPreview) {
  return planningPreview?.ok === true &&
    planningPreview.status === 'PREVIEW_READY' &&
    planningPreview.code === 'IMPLEMENTATION_PLAN_READY' &&
    planningPreview.writesPerformed === 0 &&
    planningPreview.plan &&
    planningPreview.approval &&
    DIGEST_RE.test(planningPreview.approval.approvalDigest || '') &&
    planningPreview.inputDigests &&
    planningPreview.inputDigests.profileDigest === planningPreview.plan.profileDigest &&
    planningPreview.inputDigests.packageDigest === planningPreview.plan.subjectDigest;
}

export function prepareCodeDraftRequest(input = {}) {
  const { planningInput } = input;
  if (!planningInput || typeof planningInput !== 'object' ||
      typeof planningInput.pluginRoot !== 'string') {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_INPUT_REQUIRED,
      ['planningInput 必须是完整 M4-A 输入'],
    );
  }
  const pluginRoot = planningInput.pluginRoot;
  const planningPreview = prepareImplementationPlan(planningInput);
  if (!validPlanningHandoff(planningPreview)) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_PLANNING_HANDOFF_INVALID,
      [planningPreview?.code || 'M4-A 可信输入链未通过'],
    );
  }
  const artifact = readBoundJson(
    planningInput.projectRoot,
    planningInput.refs?.artifact,
    planningPreview.inputDigests.artifactContentDigest,
  );
  const matrix = readBoundJson(
    planningInput.projectRoot,
    planningInput.refs?.matrix,
    planningPreview.inputDigests.matrixContentDigest,
  );
  if (!artifact || !matrix) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_DRIFT,
      ['M4-A 后 artifact/matrix 字节或路径发生变化'],
    );
  }
  const plan = planningPreview.plan;
  const planSchema = schemaCheck(pluginRoot, 'implementation-plan.json', plan, 'plan');
  if (!planSchema.ok || !selfDigestMatches(plan, 'planDigest')) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_PLAN_INVALID,
      planSchema.ok ? ['planDigest 无法复算'] : planSchema.violations,
    );
  }
  const contract = validateArtifactContract(pluginRoot, artifact, 'artifact.e2e-test@1');
  if (contract.method === 'unavailable' || !contract.valid) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_ARTIFACT_INVALID,
      ['artifact 合同无法验证'],
    );
  }
  const matrixSchema = schemaCheck(pluginRoot, 'matrix.json', matrix, 'matrix');
  if (!matrixSchema.ok) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_DRIFT,
      matrixSchema.violations,
    );
  }
  const matrixById = new Map(matrix.cases.map(item => [item.case_id, item]));
  const artifactById = new Map(artifact.test_cases.map(item => [item.case_id, item]));
  if (matrixById.size !== matrix.cases.length ||
      artifactById.size !== artifact.test_cases.length ||
      !exactCaseSet(
        plan.cases,
        matrix.cases.map(item => ({ caseId: item.case_id })),
      ) ||
      !exactCaseSet(
        plan.cases,
        artifact.test_cases.map(item => ({ caseId: item.case_id })),
      )) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_DRIFT,
      ['plan/artifact/matrix case 集不一致或重复'],
    );
  }
  const cases = [];
  for (const planCase of plan.cases) {
    if (!safeReference(planCase.targetFile) ||
        !safeReference(planCase.businessOracleRef)) {
      return failure(
        DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_DRIFT,
        [`不安全 ref:${planCase.caseId}`],
      );
    }
    const matrixCase = matrixById.get(planCase.caseId);
    const artifactCase = artifactById.get(planCase.caseId);
    const requestCase = makeRequestCase(planCase, matrixCase, artifactCase);
    if (!requestCase ||
        planCase.title !== `${planCase.caseId} ${artifactCase.goal}` ||
        planCase.targetFile !== matrixCase.automation.implementation_binding) {
      return failure(
        DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_DRIFT,
        [`规格与 plan 漂移:${planCase.caseId}`],
      );
    }
    cases.push(requestCase);
  }
  const requestUnsigned = {
    contract: REQUEST_CONTRACT,
    planDigest: plan.planDigest,
    cases,
    policy: {
      locatorApproaches: [...LOCATOR_APPROACHES],
      waitKinds: [...WAIT_KINDS],
      maxRetry: 0,
      forbiddenPatterns: [...FORBIDDEN_PATTERNS],
    },
  };
  const request = deepFreeze({
    ...requestUnsigned,
    requestDigest: stableDigest(requestUnsigned),
  });
  const requestSchema = schemaCheck(
    pluginRoot,
    'code-draft-request.json',
    request,
    'request',
  );
  if (!requestSchema.ok) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_REQUEST_INVALID,
      requestSchema.violations,
    );
  }
  TRUSTED_REQUESTS.set(request, {
    planningPreview,
    planningInput: structuredClone(planningInput),
    pluginRoot,
  });
  return {
    ok: true,
    status: 'DRAFT_REQUEST_READY',
    code: 'CODE_DRAFT_REQUEST_READY',
    request,
    writesPerformed: 0,
  };
}

/**
 * 用 TypeScript parser 检测 skip/fixme/only 结构规则（Node 2.4 parser 化，
 * 取代启发式剥离器及其全部已知边界——正则字面量内引号、关键字后正则、
 * 属性名伪装、`}` 后除号歧义等均由真实 AST 天然覆盖）：
 * - PropertyAccessExpression：test/describe.only|skip|fixme(...) 命中；
 * - ElementAccessExpression：test/describe['only'|'skip'|'fixme'](...)
 *   计算属性（字符串/无替换模板字面量）同法命中；
 * - 解析失败（非合法 JS/TS）fail-closed：返回 SOURCE_PARSE_FAILED
 *   （按含违规处理，不静默放行）。
 * 只使用 typescript 的 parser/scanner API，不引入编译链其余部分。
 * 同时供 browser-code-review.mjs 复用（单一实现，不再需要副本一致性断言）。
 */
const STRUCTURAL_CALL_CODES = Object.freeze({
  only: 'TEST_ONLY',
  skip: 'SKIP_OR_FIXME',
  fixme: 'SKIP_OR_FIXME',
});

export function detectStructuralViolations(source) {
  const sourceFile = ts.createSourceFile(
    'draft.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics || []).length > 0) {
    return ['SOURCE_PARSE_FAILED'];
  }
  const violations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === 'test' ||
            callee.expression.text === 'describe')) {
        const hit = STRUCTURAL_CALL_CODES[callee.name.text];
        if (hit) violations.push(hit);
      } else if (ts.isElementAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === 'test' ||
            callee.expression.text === 'describe') &&
          (ts.isStringLiteral(callee.argumentExpression) ||
            ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression))) {
        const hit = STRUCTURAL_CALL_CODES[callee.argumentExpression.text];
        if (hit) violations.push(hit);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(violations)];
}

function sourceViolations(draft, requestCase) {
  const source = draft.source;
  const violations = [];
  if (source.startsWith('\uFEFF') || source.includes('\0') ||
      source.includes('\r') || !source.endsWith('\n')) {
    violations.push('SOURCE_BYTES_NOT_CANONICAL');
  }
  if (!source.includes(requestCase.caseId) ||
      !source.includes(requestCase.title)) {
    violations.push('CASE_ID_OR_TITLE_MISSING');
  }
  if (draft.locatorApproach === 'role' && !source.includes('getByRole(')) {
    violations.push('ROLE_LOCATOR_NOT_EVIDENCED');
  }
  if (draft.locatorApproach === 'test-id' && !source.includes('getByTestId(')) {
    violations.push('TEST_ID_LOCATOR_NOT_EVIDENCED');
  }
  // skip/fixme/only 结构规则用 TypeScript AST 遍历检测（parser 化，
  // 取代启发式剥离器）；解析失败 fail-closed 按含违规处理；
  // 其余 forbidden 规则保持原文/正则语义不动
  violations.push(...detectStructuralViolations(source));
  const forbidden = [
    ['CSS_SELECTOR_CHAIN', /(?:\.locator\s*\(|querySelector(?:All)?\s*\(|\$\$\s*\()/],
    ['FIXED_WAIT', /(?:waitForTimeout|setTimeout|sleep)\s*\(/],
    ['ARBITRARY_RETRY', /\bretr(?:y|ies)\b/i],
    ['DYNAMIC_CODE_EXECUTION', /\b(?:eval|Function)\s*\(/],
    ['COMMAND_OR_FILESYSTEM_ACCESS', /(?:node:)?(?:child_process|fs\/promises|fs|process)\b|(?:exec|spawn|fork)\s*\(/],
    ['NETWORK_ACCESS', /(?:node:)?(?:http|https|net|tls|dgram)\b|\bfetch\s*\(|\baxios\b/],
    ['SECRET_LEAK', /\b(?:password|secret|api[_-]?key|access[_-]?token)\b/i],
    ['ABSOLUTE_PATH_LEAK', /(?:^|[ "'`])(?:\/(?:Users|home|tmp|private|var|etc)\/|[A-Za-z]:[\\/])/m],
  ];
  for (const [code, pattern] of forbidden) {
    if (pattern.test(source)) {
      violations.push(code);
    }
  }
  if (draft.retryPolicy.max !== 0) violations.push('RETRY_NOT_ZERO');
  if (draft.waitStrategy.timeoutMs > requestCase.oracle.timeoutMs) {
    violations.push('WAIT_EXCEEDS_ORACLE_TIMEOUT');
  }
  return violations;
}

export function acceptCodeDraftPreview(input = {}) {
  const { request, providerResult } = input;
  const handoff = request && TRUSTED_REQUESTS.get(request);
  if (!handoff || !providerResult) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_INPUT_REQUIRED,
      ['request 必须是本进程 M4-A→M4-B 生成的原对象，且 providerResult 必填'],
    );
  }
  const { pluginRoot, planningPreview } = handoff;
  const plan = planningPreview.plan;
  const planSchema = schemaCheck(pluginRoot, 'implementation-plan.json', plan, 'plan');
  const requestSchema = schemaCheck(
    pluginRoot,
    'code-draft-request.json',
    request,
    'request',
  );
  if (!planSchema.ok ||
      !requestSchema.ok ||
      !selfDigestMatches(plan, 'planDigest') ||
      !selfDigestMatches(request, 'requestDigest') ||
      request.planDigest !== plan.planDigest ||
      !exactCaseSet(plan.cases, request.cases)) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_REQUEST_MISMATCH,
      ['request 与 plan 不一致或摘要无效'],
    );
  }
  const resultSchema = schemaCheck(
    pluginRoot,
    'code-draft-provider-result.json',
    providerResult,
    'providerResult',
  );
  if (!resultSchema.ok || !selfDigestMatches(providerResult, 'resultDigest')) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_RESULT_INVALID,
      resultSchema.ok ? ['resultDigest 无法复算'] : resultSchema.violations,
    );
  }
  if (providerResult.requestDigest !== request.requestDigest) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_REQUEST_MISMATCH,
      ['providerResult.requestDigest 错绑'],
    );
  }
  if (!exactCaseSet(request.cases, providerResult.drafts)) {
    return failure(
      DRAFT_FAILURE_CODES.M4_DRAFT_CASE_SET_MISMATCH,
      ['provider case 集缺失、重复或多余'],
    );
  }
  const planById = new Map(plan.cases.map(item => [item.caseId, item]));
  const requestById = new Map(request.cases.map(item => [item.caseId, item]));
  const previews = [];
  const generatedTests = [];
  for (const draft of providerResult.drafts) {
    const planCase = planById.get(draft.caseId);
    const requestCase = requestById.get(draft.caseId);
    if (draft.file !== planCase.targetFile ||
        draft.file !== requestCase.file ||
        draft.title !== planCase.title ||
        draft.title !== requestCase.title ||
        requestCase.fixtureDigest !== planCase.fixtureDigest ||
        requestCase.assertionDigest !== planCase.assertionDigest) {
      return failure(
        DRAFT_FAILURE_CODES.M4_DRAFT_CASE_DRIFT,
        [`case 元数据漂移:${draft.caseId}`],
      );
    }
    const violations = sourceViolations(draft, requestCase);
    if (violations.length > 0) {
      return failure(
        violations.some(item => item.startsWith('SOURCE_'))
          ? DRAFT_FAILURE_CODES.M4_DRAFT_SOURCE_UNSAFE
          : DRAFT_FAILURE_CODES.M4_DRAFT_POLICY_VIOLATION,
        violations.map(item => `${draft.caseId}:${item}`),
      );
    }
    const generatedUnsigned = {
      caseId: draft.caseId,
      file: draft.file,
      title: draft.title,
      fixtureDigest: requestCase.fixtureDigest,
      assertionDigest: requestCase.assertionDigest,
      contentDigest: contentDigest(draft.source),
      locatorApproach: draft.locatorApproach,
      waitStrategy: structuredClone(draft.waitStrategy),
      retryPolicy: structuredClone(draft.retryPolicy),
    };
    const generatedTest = {
      ...generatedUnsigned,
      testDigest: stableDigest(generatedUnsigned),
    };
    const generatedSchema = schemaCheck(
      pluginRoot,
      'generated-test.json',
      generatedTest,
      'generatedTest',
    );
    if (!generatedSchema.ok) {
      return failure(
        DRAFT_FAILURE_CODES.M4_DRAFT_GENERATED_TEST_INVALID,
        generatedSchema.violations,
      );
    }
    previews.push({
      caseId: draft.caseId,
      file: draft.file,
      source: draft.source,
      contentDigest: generatedTest.contentDigest,
    });
    generatedTests.push(generatedTest);
  }
  const preview = deepFreeze({
    ok: true,
    status: 'DRAFT_PREVIEW_READY',
    code: 'CODE_DRAFT_PREVIEW_READY',
    provider: structuredClone(providerResult.provider),
    planDigest: plan.planDigest,
    requestDigest: request.requestDigest,
    resultDigest: providerResult.resultDigest,
    previews,
    generatedTests,
    writesPerformed: 0,
    claimScope: null,
  });
  TRUSTED_PREVIEWS.set(preview, {
    request,
    planningPreview,
    planningInput: structuredClone(handoff.planningInput),
    pluginRoot,
  });
  return preview;
}

export function readTrustedDraftContext(request, preview) {
  const requestContext = request && TRUSTED_REQUESTS.get(request);
  const previewContext = preview && TRUSTED_PREVIEWS.get(preview);
  if (!requestContext ||
      !previewContext ||
    previewContext.request !== request ||
    previewContext.planningPreview !== requestContext.planningPreview ||
      preview.requestDigest !== request.requestDigest ||
      preview.planDigest !== requestContext.planningPreview.plan.planDigest) {
    return null;
  }
  return Object.freeze({
    request,
    preview,
    planningPreview: requestContext.planningPreview,
    planningInput: structuredClone(requestContext.planningInput),
    pluginRoot: requestContext.pluginRoot,
  });
}
