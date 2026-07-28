/**
 * M4-C 内部 Playwright 草稿 review/repair 请求编译器。
 *
 * 只消费 M4-B 模块私有身份绑定的 request/preview。review finding 从冻结 source
 * 与 request 机械派生；调用方不能注入 finding 或改变业务 oracle。
 */

import { createHash } from 'node:crypto';

import { readTrustedDraftContext } from './browser-code-draft.mjs';
import { stableDigest } from './digest.mjs';
import { validateSchema } from './schema-validation.mjs';

const REVIEW_CONTRACT = 'e2e-test/code-review-result/v1';
const REPAIR_CONTRACT = 'e2e-test/code-repair-request/v1';
const TRUSTED_REVIEWS = new WeakMap();
const TRUSTED_REPAIR_REQUESTS = new WeakMap();

export const CODE_REVIEW_FAILURE_CODES = Object.freeze({
  M4_REVIEW_INPUT_UNTRUSTED: 'M4_REVIEW_INPUT_UNTRUSTED',
  M4_REVIEW_ROUND_INVALID: 'M4_REVIEW_ROUND_INVALID',
  M4_REVIEW_BINDING_DRIFT: 'M4_REVIEW_BINDING_DRIFT',
  M4_REVIEW_SCHEMA_INVALID: 'M4_REVIEW_SCHEMA_INVALID',
  M4_REPAIR_REVIEW_UNTRUSTED: 'M4_REPAIR_REVIEW_UNTRUSTED',
  M4_REPAIR_NOT_ALLOWED: 'M4_REPAIR_NOT_ALLOWED',
  M4_REPAIR_SCHEMA_INVALID: 'M4_REPAIR_SCHEMA_INVALID',
});

const FINDING_DEFINITIONS = Object.freeze({
  BUSINESS_ORACLE_NOT_EVIDENCED: ['high', '业务 oracle 原文未进入测试 source'],
  WEAK_BUSINESS_ASSERTION: ['high', '业务结果缺少强断言，弱可见性/truthy 不能替代'],
  CSS_SELECTOR_CHAIN: ['high', '使用了脆弱 CSS/query selector 定位'],
  FIXED_WAIT: ['high', '使用了固定等待或 sleep'],
  SKIP_OR_FIXME: ['high', '测试包含 skip/fixme'],
  ARBITRARY_RETRY: ['high', '测试包含任意 retry'],
  DYNAMIC_CODE_EXECUTION: ['high', '测试包含动态代码执行'],
  COMMAND_OR_FILESYSTEM_ACCESS: ['high', '测试代码直接访问命令、进程或文件系统'],
  NETWORK_ACCESS: ['high', '测试代码绕过 Playwright 直接访问网络'],
  SECRET_LEAK: ['high', '测试代码包含疑似明文 secret'],
  ABSOLUTE_PATH_LEAK: ['high', '测试代码包含本机绝对路径'],
  IDENTITY_ISOLATION_NOT_EVIDENCED: ['medium', '未证明唯一身份隔离'],
  TEST_DATA_NOT_EVIDENCED: ['medium', '未证明规格要求的测试数据'],
  CLEANUP_NOT_EVIDENCED: ['high', '未证明 afterEach/finally cleanup'],
});

function failure(code, violations) {
  return {
    ok: false,
    status: 'BLOCKED',
    code,
    violations: [...new Set((violations || []).map(String))],
    review: null,
    repairRequest: null,
    writesPerformed: 0,
  };
}

function rawDigest(source) {
  return `sha256:${createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')}`;
}

function unsigned(value, field) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => key !== field),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schemaValid(pluginRoot, schemaFile, value) {
  try {
    return validateSchema(pluginRoot, schemaFile, value).valid;
  } catch {
    return false;
  }
}

function finding(code, caseId, source) {
  const [severity, message] = FINDING_DEFINITIONS[code];
  const basis = {
    caseId,
    code,
    sourceDigest: rawDigest(source),
  };
  const evidenceDigest = stableDigest(basis);
  return {
    findingId: `${caseId}:${code}:${evidenceDigest.slice('sha256:'.length, 18)}`,
    caseId,
    code,
    severity,
    repairOwner: 'test',
    message,
    evidenceDigest,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyRepairOwner(category) {
  if (category === 'PRODUCT_BEHAVIOR_MISMATCH') return 'product';
  if (category === 'ENVIRONMENT_BLOCKED') return 'environment';
  return 'test';
}

export function mayGenerateCodeRepair(category) {
  return classifyRepairOwner(category) === 'test';
}

export function inspectCodeSource({ source, requestCase }) {
  if (typeof source !== 'string' || !requestCase || typeof requestCase !== 'object') {
    return ['BUSINESS_ORACLE_NOT_EVIDENCED', 'WEAK_BUSINESS_ASSERTION'];
  }
  const codes = [];
  if (!source.includes(requestCase.oracle?.criterion || '\0')) {
    codes.push('BUSINESS_ORACLE_NOT_EVIDENCED');
  }
  const oracleLiteral = JSON.stringify(requestCase.oracle?.criterion || '');
  const strongAssertion = new RegExp(
    `\\.to(?:HaveText|ContainText|Equal|StrictEqual)\\s*\\(\\s*${escapeRegExp(oracleLiteral)}`,
  ).test(source);
  if (!strongAssertion ||
      /\.to(?:BeTruthy|BeDefined|BeVisible)\s*\(/.test(source) && !strongAssertion) {
    codes.push('WEAK_BUSINESS_ASSERTION');
  }
  const rules = [
    ['CSS_SELECTOR_CHAIN', /(?:\.locator\s*\(|querySelector(?:All)?\s*\(|\$\$\s*\()/],
    ['FIXED_WAIT', /(?:waitForTimeout|setTimeout|sleep)\s*\(/],
    ['SKIP_OR_FIXME', /\b(?:test|describe)\.(?:skip|fixme)\s*\(/],
    ['ARBITRARY_RETRY', /\bretr(?:y|ies)\b/i],
    ['DYNAMIC_CODE_EXECUTION', /\b(?:eval|Function)\s*\(/],
    ['COMMAND_OR_FILESYSTEM_ACCESS', /(?:node:)?(?:child_process|fs\/promises|fs|process)\b|(?:exec|spawn|fork)\s*\(/],
    ['NETWORK_ACCESS', /(?:node:)?(?:http|https|net|tls|dgram)\b|\bfetch\s*\(|\baxios\b/],
    ['SECRET_LEAK', /\b(?:password|secret|api[_-]?key|access[_-]?token)\b/i],
    ['ABSOLUTE_PATH_LEAK', /(?:^|[ "'`])(?:\/(?:Users|home|tmp|private|var|etc)\/|[A-Za-z]:[\\/])/m],
  ];
  for (const [code, pattern] of rules) {
    if (pattern.test(source)) codes.push(code);
  }
  const identityPrefixes = (requestCase.fixture?.identities || [])
    .map(value => String(value).replace(/\$\{uuid\}/gi, ''))
    .filter(Boolean);
  if (!/(?:randomUUID\s*\(|\buuid\b)/i.test(source) ||
      identityPrefixes.some(prefix => !source.includes(prefix))) {
    codes.push('IDENTITY_ISOLATION_NOT_EVIDENCED');
  }
  const testData = (requestCase.fixture?.testData || []).map(String).filter(Boolean);
  if (testData.length > 0 && !testData.some(value => source.includes(value))) {
    codes.push('TEST_DATA_NOT_EVIDENCED');
  }
  if (!/(?:test\.afterEach\s*\(|\bfinally\s*\{)/.test(source)) {
    codes.push('CLEANUP_NOT_EVIDENCED');
  }
  return [...new Set(codes)];
}

function validatePreviewBinding(context) {
  const { request, preview, planningPreview } = context;
  if (preview.previews.length !== request.cases.length ||
      preview.generatedTests.length !== request.cases.length ||
      preview.planDigest !== planningPreview.plan.planDigest) return false;
  for (const requestCase of request.cases) {
    const sourcePreview = preview.previews.find(item => item.caseId === requestCase.caseId);
    const generated = preview.generatedTests.find(item => item.caseId === requestCase.caseId);
    if (!sourcePreview || !generated ||
        sourcePreview.file !== requestCase.file ||
        generated.file !== requestCase.file ||
        generated.title !== requestCase.title ||
        generated.fixtureDigest !== requestCase.fixtureDigest ||
        generated.assertionDigest !== requestCase.assertionDigest ||
        rawDigest(sourcePreview.source) !== sourcePreview.contentDigest ||
        sourcePreview.contentDigest !== generated.contentDigest ||
        stableDigest(unsigned(generated, 'testDigest')) !== generated.testDigest) {
      return false;
    }
  }
  return true;
}

export function reviewCodeDraft(input = {}) {
  const { request, preview, repairRound = 0 } = input;
  const context = readTrustedDraftContext(request, preview);
  if (!context) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REVIEW_INPUT_UNTRUSTED,
      ['只接受 M4-B 同进程身份绑定的 request/preview'],
    );
  }
  const maxRepairRounds =
    context.planningPreview.plan.convergenceBudget.maxRepairRounds;
  if (!Number.isInteger(repairRound) ||
      repairRound < 0 ||
      repairRound > maxRepairRounds) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REVIEW_ROUND_INVALID,
      ['repairRound 超出冻结预算'],
    );
  }
  if (!validatePreviewBinding(context)) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REVIEW_BINDING_DRIFT,
      ['preview/source/GeneratedTest 摘要链漂移'],
    );
  }
  const findings = [];
  for (const requestCase of request.cases) {
    const source = preview.previews
      .find(item => item.caseId === requestCase.caseId).source;
    for (const code of inspectCodeSource({ source, requestCase })) {
      findings.push(finding(code, requestCase.caseId, source));
    }
  }
  const status = findings.length === 0
    ? 'PASS'
    : repairRound >= maxRepairRounds
      ? 'BLOCKED'
      : 'NEEDS_REPAIR';
  const reviewUnsigned = {
    contract: REVIEW_CONTRACT,
    reviewId: `code-review@${stableDigest({
      planDigest: preview.planDigest,
      resultDigest: preview.resultDigest,
      repairRound,
    }).slice('sha256:'.length)}`,
    planDigest: preview.planDigest,
    requestDigest: request.requestDigest,
    providerResultDigest: preview.resultDigest,
    repairRound,
    maxRepairRounds,
    status,
    findings,
  };
  const review = deepFreeze({
    ...reviewUnsigned,
    reviewDigest: stableDigest(reviewUnsigned),
  });
  if (!schemaValid(context.pluginRoot, 'code-review-result.json', review)) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REVIEW_SCHEMA_INVALID,
      ['CodeReviewResult schema 无效'],
    );
  }
  TRUSTED_REVIEWS.set(review, context);
  return {
    ok: true,
    status,
    code: status === 'PASS'
      ? 'CODE_REVIEW_PASS'
      : status === 'NEEDS_REPAIR'
        ? 'CODE_REVIEW_NEEDS_REPAIR'
        : 'CODE_REVIEW_BLOCKED',
    review,
    writesPerformed: 0,
  };
}

export function prepareCodeRepairRequest(input = {}) {
  const { review } = input;
  const context = review && TRUSTED_REVIEWS.get(review);
  if (!context ||
      stableDigest(unsigned(review, 'reviewDigest')) !== review.reviewDigest) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REPAIR_REVIEW_UNTRUSTED,
      ['review 必须来自本进程真实 review 入口'],
    );
  }
  if (review.status !== 'NEEDS_REPAIR' ||
      review.findings.length === 0 ||
      review.findings.some(item => item.repairOwner !== 'test')) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REPAIR_NOT_ALLOWED,
      ['仅测试所有权 finding 且未超预算时可准备 repair'],
    );
  }
  const requestCaseById = new Map(
    context.request.cases.map(item => [item.caseId, item]),
  );
  const findingCaseIds = [...new Set(review.findings.map(item => item.caseId))];
  const cases = findingCaseIds.map(caseId => {
    const requestCase = requestCaseById.get(caseId);
    return {
      caseId,
      file: requestCase.file,
      title: requestCase.title,
      assertionDigest: requestCase.assertionDigest,
      oracle: structuredClone(requestCase.oracle),
      findingIds: review.findings
        .filter(item => item.caseId === caseId)
        .map(item => item.findingId),
    };
  });
  const repairUnsigned = {
    contract: REPAIR_CONTRACT,
    reviewDigest: review.reviewDigest,
    planDigest: review.planDigest,
    requestDigest: review.requestDigest,
    repairRound: review.repairRound + 1,
    cases,
    constraints: {
      preserveCaseId: true,
      preserveFile: true,
      preserveTitle: true,
      preserveAssertionDigest: true,
      preserveOracle: true,
      allowedRepairOwner: 'test',
    },
  };
  const repairRequest = deepFreeze({
    ...repairUnsigned,
    repairRequestDigest: stableDigest(repairUnsigned),
  });
  if (!schemaValid(context.pluginRoot, 'code-repair-request.json', repairRequest)) {
    return failure(
      CODE_REVIEW_FAILURE_CODES.M4_REPAIR_SCHEMA_INVALID,
      ['CodeRepairRequest schema 无效'],
    );
  }
  TRUSTED_REPAIR_REQUESTS.set(repairRequest, { review, context });
  return {
    ok: true,
    status: 'REPAIR_REQUEST_READY',
    code: 'CODE_REPAIR_REQUEST_READY',
    repairRequest,
    writesPerformed: 0,
  };
}

export function readTrustedCodeReviewContext(review) {
  const context = review && TRUSTED_REVIEWS.get(review);
  if (!context ||
      review.status !== 'PASS' ||
      stableDigest(unsigned(review, 'reviewDigest')) !== review.reviewDigest) {
    return null;
  }
  return Object.freeze({ ...context, review });
}
