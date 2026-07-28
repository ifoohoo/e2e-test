/**
 * M4-A 可信输入加载与 ImplementationPlan 生成器。
 *
 * 本模块只读项目文件并返回内存中的 preview 计划。它不签发批准、不创建 run
 * root、不写目标文件、不运行项目命令或 Playwright。
 */

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
import { createHash } from 'node:crypto';

import { validateArtifactContract } from './artifact-contract-validation.mjs';
import { stableDigest } from './digest.mjs';
import {
  matrixDigest,
  validateArtifactPackageManifest,
  validateMatrixRoundTrip,
} from './matrix-dto.mjs';
import { detectProjectProfile } from './project-profile-detector.mjs';
import { validateSchema } from './schema-validation.mjs';

const APPROVAL_NAMESPACE = '.artifact-graph/approvals/e2e-test';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVIEW_CHECKS = Object.freeze([
  'schema_valid',
  'contract_valid',
  'matrix_complete',
  'relations_valid',
]);
const FORBIDDEN_PATTERNS = Object.freeze([
  'fixed-wait',
  'skip',
  'fixme',
  'arbitrary-retry',
  'weak-assertion',
]);

function rawDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export const FAILURE_CODES = Object.freeze({
  M4_INPUT_REQUIRED: 'M4_INPUT_REQUIRED',
  M4_PROJECT_ROOT_INVALID: 'M4_PROJECT_ROOT_INVALID',
  M4_INPUT_PATH_UNSAFE: 'M4_INPUT_PATH_UNSAFE',
  M4_INPUT_SYMLINK: 'M4_INPUT_SYMLINK',
  M4_INPUT_NOT_FOUND: 'M4_INPUT_NOT_FOUND',
  M4_INPUT_NOT_FILE: 'M4_INPUT_NOT_FILE',
  M4_INPUT_READ_FAILED: 'M4_INPUT_READ_FAILED',
  M4_INPUT_PARSE_FAILED: 'M4_INPUT_PARSE_FAILED',
  M4_INPUT_SCHEMA_INVALID: 'M4_INPUT_SCHEMA_INVALID',
  M4_ARTIFACT_CONTRACT_UNAVAILABLE: 'M4_ARTIFACT_CONTRACT_UNAVAILABLE',
  M4_ARTIFACT_CONTRACT_INVALID: 'M4_ARTIFACT_CONTRACT_INVALID',
  M4_MATRIX_INCONSISTENT: 'M4_MATRIX_INCONSISTENT',
  M4_PACKAGE_CHAIN_INVALID: 'M4_PACKAGE_CHAIN_INVALID',
  M4_PROOF_CHAIN_INVALID: 'M4_PROOF_CHAIN_INVALID',
  M4_PROFILE_INVALID: 'M4_PROFILE_INVALID',
  M4_PROFILE_STALE: 'M4_PROFILE_STALE',
  M4_PROFILE_UNSUPPORTED: 'M4_PROFILE_UNSUPPORTED',
  M4_PLAYWRIGHT_REQUIRED: 'M4_PLAYWRIGHT_REQUIRED',
  M4_TARGET_PATH_INVALID: 'M4_TARGET_PATH_INVALID',
  M4_TARGET_OUTSIDE_TEST_DIR: 'M4_TARGET_OUTSIDE_TEST_DIR',
  M4_PLAN_SCHEMA_INVALID: 'M4_PLAN_SCHEMA_INVALID',
});

function failure(code, violations, status = 'BLOCKED') {
  return {
    ok: false,
    status,
    code,
    violations: [...new Set((violations || []).map(String))],
    plan: null,
    writesPerformed: 0,
  };
}

function safeRelativePath(ref) {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  if (isAbsolute(ref) || ref.startsWith('/') || ref.includes('\\') || ref.includes('\0')) return false;
  const segments = ref.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function trimSlash(ref) {
  return typeof ref === 'string' ? ref.replace(/\/+$/, '') : ref;
}

function pathsOverlap(left, right) {
  const a = trimSlash(left);
  const b = trimSlash(right);
  if (!safeRelativePath(a) || !safeRelativePath(b)) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !existsSync(projectRoot)) {
    return failure(FAILURE_CODES.M4_PROJECT_ROOT_INVALID, ['projectRoot 不存在']);
  }
  try {
    const stat = lstatSync(projectRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return failure(FAILURE_CODES.M4_PROJECT_ROOT_INVALID, ['projectRoot 不是可信目录']);
    }
    return { ok: true, root: realpathSync(projectRoot) };
  } catch {
    return failure(FAILURE_CODES.M4_PROJECT_ROOT_INVALID, ['projectRoot 无法读取']);
  }
}

function inspectRelativePath(root, ref, { requireFile = true } = {}) {
  if (!safeRelativePath(ref)) {
    return failure(FAILURE_CODES.M4_INPUT_PATH_UNSAFE, [`不安全相对路径:${String(ref)}`]);
  }
  let current = root;
  try {
    for (const segment of ref.split('/')) {
      current = resolve(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        return failure(FAILURE_CODES.M4_INPUT_SYMLINK, [`符号链接路径:${ref}`]);
      }
    }
    const target = resolve(root, ref);
    const resolvedTarget = existsSync(target) ? realpathSync(target) : target;
    const rel = relative(root, resolvedTarget);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return failure(FAILURE_CODES.M4_INPUT_PATH_UNSAFE, [`路径逃逸:${ref}`]);
    }
    if (!requireFile) return { ok: true, target };
    if (!existsSync(target)) {
      return failure(FAILURE_CODES.M4_INPUT_NOT_FOUND, [`输入不存在:${ref}`]);
    }
    if (!lstatSync(target).isFile()) {
      return failure(FAILURE_CODES.M4_INPUT_NOT_FILE, [`输入不是普通文件:${ref}`]);
    }
    return { ok: true, target };
  } catch {
    return failure(FAILURE_CODES.M4_INPUT_READ_FAILED, [`路径检查失败:${ref}`]);
  }
}

function readJsonInput(root, ref) {
  const inspected = inspectRelativePath(root, ref);
  if (!inspected.ok) return inspected;
  let bytes;
  try {
    bytes = readFileSync(inspected.target);
  } catch {
    return failure(FAILURE_CODES.M4_INPUT_READ_FAILED, [`输入读取失败:${ref}`]);
  }
  try {
    return {
      ok: true,
      bytes,
      text: bytes.toString('utf8'),
      value: JSON.parse(bytes.toString('utf8')),
    };
  } catch {
    return failure(FAILURE_CODES.M4_INPUT_PARSE_FAILED, [`JSON 解析失败:${ref}`]);
  }
}

function validateDocumentSchema(pluginRoot, schemaFile, value, label) {
  try {
    const result = validateSchema(pluginRoot, schemaFile, value);
    return result.valid
      ? { ok: true }
      : failure(
        FAILURE_CODES.M4_INPUT_SCHEMA_INVALID,
        result.errors.map(error => `${label}:${error.instancePath || '/'}:${error.keyword}`),
      );
  } catch {
    return failure(FAILURE_CODES.M4_INPUT_SCHEMA_INVALID, [`schema 不可用:${label}`]);
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(value => rightSet.has(value));
}

function validateProofChain(proof, { manifest, manifestRef, matrix, artifact }) {
  if (proof.subject?.package_id !== manifest.packageId ||
      proof.subject?.package_digest !== manifest.packageDigest ||
      proof.subject?.manifest_ref !== manifestRef) {
    return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, ['proof subject 与 package manifest 不一致']);
  }

  const matrixIds = matrix.cases.map(item => item.case_id);
  const artifactIds = artifact.test_cases.map(item => item.case_id);
  const proofIds = proof.bindings.map(item => item.case_id);
  if (!sameStringSet(matrixIds, artifactIds) || !sameStringSet(matrixIds, proofIds)) {
    return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, ['proof/matrix/artifact case 集不一致或重复']);
  }

  const matrixById = new Map(matrix.cases.map(item => [item.case_id, item]));
  for (const binding of proof.bindings) {
    if (!DIGEST_RE.test(binding.binding_digest || '')) {
      return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, [`binding_digest 缺失:${binding.case_id}`]);
    }
    if (stableDigest(Object.fromEntries(
      Object.entries(binding).filter(([key]) => key !== 'binding_digest'),
    )) !== binding.binding_digest) {
      return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, [`binding_digest 漂移:${binding.case_id}`]);
    }
    if (binding.proof_state === 'stale') {
      return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, [`proof 已失鲜:${binding.case_id}`]);
    }
    if (['candidate-linked', 'implementation-bound', 'evidence-bound'].includes(binding.proof_state)) {
      const source = matrixById.get(binding.case_id)?.source_scope;
      const trace = binding.source_trace;
      if (!trace ||
          trace.feature_id !== (source.feature_ref || source.source_artifact) ||
          trace.scenario_id !== source.scenario_ref ||
          !sameStringSet(trace.ac_ids, source.acceptance_criteria) ||
          (trace.ac_id !== undefined && trace.ac_id !== trace.ac_ids[0])) {
        return failure(FAILURE_CODES.M4_PROOF_CHAIN_INVALID, [`proof source trace 漂移:${binding.case_id}`]);
      }
    }
  }
  return { ok: true, proofDigest: stableDigest(proof) };
}

function reviewSummaryMatches(review) {
  if (!Array.isArray(review?.findings) || !review.summary || typeof review.summary !== 'object') return false;
  const expected = {
    total: review.findings.length,
    high: review.findings.filter(item => item.severity === 'high').length,
    medium: review.findings.filter(item => item.severity === 'medium').length,
    low: review.findings.filter(item => item.severity === 'low').length,
    safe_fix: review.findings.filter(item => item.repairability === 'safe-fix').length,
    business_decision: review.findings.filter(item => item.repairability === 'business-decision').length,
    out_of_scope: review.findings.filter(item => item.repairability === 'out-of-scope').length,
  };
  return Object.entries(expected).every(([key, value]) => review.summary[key] === value);
}

function findingSetMatches(review, accepted) {
  if (!Array.isArray(review?.findings) || !Array.isArray(accepted)) return false;
  const expected = review.findings.map(item => stableDigest(item));
  return sameStringSet(expected, accepted);
}

export function validateSpecificationApproval({
  receipt,
  receiptRef,
  review,
  packageId,
  packageDigest,
  proofRef,
  proofDigest,
  artifactRef,
  matrixRef,
  currentMatrixDigest,
  now,
  allowedWritePaths,
}) {
  const violations = [];
  if (!safeRelativePath(receiptRef)) {
    violations.push('APPROVAL_PATH_UNSAFE');
  } else if (!receiptRef.startsWith(`${APPROVAL_NAMESPACE}/`)) {
    violations.push('APPROVAL_PATH_NOT_AUTHORITATIVE');
  }
  for (const ref of [receipt.review?.resultRef, receipt.subject?.proofRef]) {
    if (!safeRelativePath(ref)) violations.push('APPROVAL_PATH_UNSAFE');
  }
  if ([receiptRef, receipt.review?.resultRef, receipt.subject?.proofRef, APPROVAL_NAMESPACE]
    .some(protectedPath => (allowedWritePaths || [])
      .some(writePath => pathsOverlap(protectedPath, writePath)))) {
    violations.push('APPROVAL_WRITESET_OVERLAP');
  }
  if (stableDigest(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'approvalDigest'),
  )) !== receipt.approvalDigest) {
    violations.push('APPROVAL_DIGEST_MISMATCH');
  }
  if (receipt.subject?.packageId !== packageId ||
      receipt.subject?.packageDigest !== packageDigest ||
      receipt.subject?.proofRef !== proofRef ||
      receipt.subject?.proofDigest !== proofDigest) {
    violations.push('APPROVAL_SUBJECT_MISMATCH');
  }
  const reviewDigest = stableDigest(review);
  if (receipt.review?.resultDigest !== reviewDigest) {
    violations.push('APPROVAL_REVIEW_DIGEST_MISMATCH');
  }
  if (review?.artifact_ref !== artifactRef ||
      review?.matrix_ref !== matrixRef ||
      review?.matrix_digest !== currentMatrixDigest) {
    violations.push('APPROVAL_REVIEW_SCOPE_MISMATCH');
  }
  if (review?.overall_status !== 'PASS') violations.push('APPROVAL_REVIEW_NOT_PASS');
  const checks = review?.deterministic_checks;
  if (!checks ||
      Object.keys(checks).length !== REVIEW_CHECKS.length ||
      REVIEW_CHECKS.some(key => checks[key] !== true)) {
    violations.push('APPROVAL_DETERMINISTIC_CHECK_FAILED');
  }
  if (!reviewSummaryMatches(review)) violations.push('APPROVAL_REVIEW_SUMMARY_MISMATCH');
  if (!findingSetMatches(review, receipt.review?.acceptedFindingDigests)) {
    violations.push('APPROVAL_FINDING_SET_MISMATCH');
  }
  if (review?.findings?.some(item => item.severity === 'high')) {
    violations.push('APPROVAL_HIGH_FINDING');
  }
  if (receipt.validUntil !== undefined &&
      (!Number.isFinite(now) || now >= Date.parse(receipt.validUntil))) {
    violations.push('APPROVAL_EXPIRED');
  }
  const unique = [...new Set(violations)];
  return unique.length
    ? { ok: false, code: unique[0], violations: unique }
    : { ok: true, code: 'APPROVAL_VERIFIED', violations: [], reviewDigest };
}

function validateCurrentProfile(pluginRoot, projectRoot, profile) {
  const schema = validateDocumentSchema(pluginRoot, 'project-profile.json', profile, 'profile');
  if (!schema.ok) return failure(FAILURE_CODES.M4_PROFILE_INVALID, schema.violations);
  const unsigned = Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== 'profileDigest'),
  );
  if (stableDigest(unsigned) !== profile.profileDigest) {
    return failure(FAILURE_CODES.M4_PROFILE_INVALID, ['profileDigest 无法复算']);
  }
  if (Object.values(profile.unsupported).some(Boolean)) {
    return failure(
      FAILURE_CODES.M4_PROFILE_UNSUPPORTED,
      ['ProjectProfile 命中不支持边界'],
      'UNSUPPORTED',
    );
  }
  if (!['typescript', 'javascript'].includes(profile.repoTopology.language)) {
    return failure(
      FAILURE_CODES.M4_PROFILE_UNSUPPORTED,
      ['仅支持 TypeScript/JavaScript'],
      'UNSUPPORTED',
    );
  }
  if (profile.playwright.present !== true) {
    return failure(FAILURE_CODES.M4_PLAYWRIGHT_REQUIRED, ['Playwright 未被文件事实证明']);
  }
  const explicit = {
    ...profile.explicitFacts,
    ...(profile.startCommand ? { startCommand: profile.startCommand } : {}),
  };
  const current = detectProjectProfile(projectRoot, explicit, pluginRoot);
  if (current.status !== 'OK' || current.profile?.profileDigest !== profile.profileDigest) {
    return failure(FAILURE_CODES.M4_PROFILE_STALE, ['ProjectProfile 与当前项目事实不一致']);
  }
  return { ok: true };
}

function buildPlan({ matrix, artifact, matrixRef, manifest, profile, root }) {
  const artifactById = new Map(artifact.test_cases.map(item => [item.case_id, item]));
  const cases = [];
  for (const matrixCase of matrix.cases) {
    const artifactCase = artifactById.get(matrixCase.case_id);
    const targetFile = matrixCase.automation?.implementation_binding;
    if (!safeRelativePath(targetFile) ||
        /[*?[\]{}]/.test(targetFile) ||
        !/\.spec\.(?:ts|js)$/.test(targetFile)) {
      return failure(FAILURE_CODES.M4_TARGET_PATH_INVALID, [`无效目标文件:${matrixCase.case_id}`]);
    }
    const targetCheck = inspectRelativePath(root, targetFile, { requireFile: false });
    if (!targetCheck.ok) {
      return failure(FAILURE_CODES.M4_TARGET_PATH_INVALID, targetCheck.violations);
    }
    const inCandidateDir = profile.candidateTestDirs.some(dir =>
      safeRelativePath(dir) && (targetFile === dir || targetFile.startsWith(`${dir}/`)));
    if (!inCandidateDir) {
      return failure(FAILURE_CODES.M4_TARGET_OUTSIDE_TEST_DIR, [`目标不在候选测试目录:${matrixCase.case_id}`]);
    }
    cases.push({
      caseId: matrixCase.case_id,
      targetFile,
      title: `${matrixCase.case_id} ${artifactCase.goal}`,
      fixtureDigest: stableDigest({
        data_identity: matrixCase.data_identity,
        environment: matrixCase.environment,
        cleanup: matrixCase.cleanup,
      }),
      assertionDigest: stableDigest({
        matrixOracle: matrixCase.oracle,
        artifactOracles: artifactCase.oracles,
      }),
      businessOracleRef: `${matrixRef}#cases/${matrixCase.case_id}/oracle`,
      allowedWritePaths: [targetFile],
    });
  }
  const planIdentity = stableDigest({
    packageDigest: manifest.packageDigest,
    profileDigest: profile.profileDigest,
    cases,
  });
  const unsigned = {
    planId: `implementation-plan@${planIdentity.slice('sha256:'.length)}`,
    subjectDigest: manifest.packageDigest,
    profileDigest: profile.profileDigest,
    cases,
    locatorStrategy: 'role',
    forbiddenPatterns: [...FORBIDDEN_PATTERNS],
    convergenceBudget: { maxRepairRounds: 3 },
  };
  return {
    ok: true,
    plan: { ...unsigned, planDigest: stableDigest(unsigned) },
    allowedWritePaths: [...new Set(cases.map(item => item.targetFile))].sort(),
  };
}

export function prepareImplementationPlan(input = {}) {
  const { pluginRoot, projectRoot, refs, profile, now } = input;
  if (typeof pluginRoot !== 'string' ||
      !refs || typeof refs !== 'object' ||
      !profile || typeof profile !== 'object' ||
      !Number.isFinite(now)) {
    return failure(FAILURE_CODES.M4_INPUT_REQUIRED, ['pluginRoot/refs/profile/now 必填']);
  }
  const rootResult = validateProjectRoot(projectRoot);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.root;
  const requiredNames = ['artifact', 'matrix', 'packageManifest', 'proof', 'approvalReceipt'];
  if (requiredNames.some(name => typeof refs[name] !== 'string')) {
    return failure(FAILURE_CODES.M4_INPUT_REQUIRED, ['输入 ref 不完整']);
  }

  const documents = {};
  for (const name of requiredNames) {
    const loaded = readJsonInput(root, refs[name]);
    if (!loaded.ok) return loaded;
    documents[name] = loaded;
  }
  const { artifact, matrix, packageManifest: manifest, proof, approvalReceipt: receipt } =
    Object.fromEntries(Object.entries(documents).map(([name, item]) => [name, item.value]));

  for (const [schemaFile, value, label] of [
    ['matrix.json', matrix, 'matrix'],
    ['artifact-package-manifest.json', manifest, 'packageManifest'],
    ['proof-binding.json', proof, 'proof'],
    ['specification-approval-receipt.json', receipt, 'approvalReceipt'],
  ]) {
    const checked = validateDocumentSchema(pluginRoot, schemaFile, value, label);
    if (!checked.ok) return checked;
  }
  if (!refs.approvalReceipt.startsWith(`${APPROVAL_NAMESPACE}/`)) {
    return failure('APPROVAL_PATH_NOT_AUTHORITATIVE', ['receipt 不在固定权威命名空间']);
  }
  if (refs.proof !== receipt.subject.proofRef) {
    return failure('APPROVAL_SUBJECT_MISMATCH', ['receipt proofRef 与输入不一致']);
  }
  const reviewLoaded = readJsonInput(root, receipt.review.resultRef);
  if (!reviewLoaded.ok) return reviewLoaded;
  const reviewSchema = validateDocumentSchema(pluginRoot, 'review-result.json', reviewLoaded.value, 'reviewResult');
  if (!reviewSchema.ok) return reviewSchema;

  const contract = validateArtifactContract(resolve(pluginRoot), artifact, 'artifact.e2e-test@1');
  if (contract.method === 'unavailable') {
    return failure(FAILURE_CODES.M4_ARTIFACT_CONTRACT_UNAVAILABLE, ['Artifact Graph 合同验证器不可用']);
  }
  if (!contract.valid) {
    return failure(FAILURE_CODES.M4_ARTIFACT_CONTRACT_INVALID, ['artifact 合同无效']);
  }
  const roundTrip = validateMatrixRoundTrip(matrix, artifact, matrix);
  if (!roundTrip.complete) {
    return failure(
      FAILURE_CODES.M4_MATRIX_INCONSISTENT,
      roundTrip.missing.map(item => `${item.caseId}:${item.dimension}:${item.field}`),
    );
  }
  const packageCheck = validateArtifactPackageManifest(manifest, {
    artifact,
    matrix,
    artifactBytes: documents.artifact.bytes,
    matrixBytes: documents.matrix.bytes,
  });
  const matrixMember = manifest.members.find(item => item.role === 'eight-dimensional-matrix');
  if (!packageCheck.valid ||
      manifest.subject.ref !== refs.artifact ||
      manifest.subject.artifactId !== artifact.metadata.id ||
      matrixMember?.ref !== refs.matrix ||
      matrixMember?.memberId !== matrix.matrix_id) {
    return failure(
      FAILURE_CODES.M4_PACKAGE_CHAIN_INVALID,
      packageCheck.violations.length ? packageCheck.violations : ['package ref/id 漂移'],
    );
  }

  const proofCheck = validateProofChain(proof, {
    manifest,
    manifestRef: refs.packageManifest,
    matrix,
    artifact,
  });
  if (!proofCheck.ok) return proofCheck;
  const profileCheck = validateCurrentProfile(pluginRoot, projectRoot, profile);
  if (!profileCheck.ok) return profileCheck;
  const planResult = buildPlan({ matrix, artifact, matrixRef: refs.matrix, manifest, profile, root });
  if (!planResult.ok) return planResult;

  const approval = validateSpecificationApproval({
    receipt,
    receiptRef: refs.approvalReceipt,
    review: reviewLoaded.value,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    proofRef: refs.proof,
    proofDigest: proofCheck.proofDigest,
    artifactRef: refs.artifact,
    matrixRef: refs.matrix,
    currentMatrixDigest: matrixDigest(matrix),
    now,
    allowedWritePaths: planResult.allowedWritePaths,
  });
  if (!approval.ok) return failure(approval.code, approval.violations);

  const planSchema = validateDocumentSchema(pluginRoot, 'implementation-plan.json', planResult.plan, 'plan');
  if (!planSchema.ok ||
      stableDigest(Object.fromEntries(
        Object.entries(planResult.plan).filter(([key]) => key !== 'planDigest'),
      )) !== planResult.plan.planDigest) {
    return failure(
      FAILURE_CODES.M4_PLAN_SCHEMA_INVALID,
      planSchema.ok ? ['planDigest 无法复算'] : planSchema.violations,
    );
  }

  return {
    ok: true,
    status: 'PREVIEW_READY',
    code: 'IMPLEMENTATION_PLAN_READY',
    plan: planResult.plan,
    approval: {
      approvalId: receipt.approvalId,
      approvalDigest: receipt.approvalDigest,
    },
    inputDigests: {
      packageDigest: manifest.packageDigest,
      proofDigest: proofCheck.proofDigest,
      reviewDigest: approval.reviewDigest,
      profileDigest: profile.profileDigest,
      artifactContentDigest: rawDigest(documents.artifact.bytes),
      matrixContentDigest: rawDigest(documents.matrix.bytes),
    },
    writesPerformed: 0,
  };
}
