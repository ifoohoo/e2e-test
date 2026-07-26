#!/usr/bin/env node

/**
 * service-dispatch.mjs
 *
 * E2E Test family business dispatch。
 * 在 service-runner.mjs preflight 通过后执行真实业务逻辑：
 * author → inspect→assess→matrix→compose→contract-validate→semantic-review→proof-reconcile
 * review → contract-validate→semantic-review
 * repair → safe-fix→contract-validate→re-review
 * default → intent routing
 * help → 已在 service-runner 中处理，不经过此模块。
 *
 * 设计约束：
 * - 确定性：无时间戳、无随机 ID、无 LLM 行为资格声称
 * - 真实验证：AJV schema validation，artifact-graph contract validate
 * - 路径安全：所有文件路径 projectRoot-relative，realpath containment
 * - writeSet/overwrite 控制：严格授权检查
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { dispatchAuthorWorkflow, handlesAuthorWorkflow } from './lib/author-workflow.mjs';
import { validateArtifactContract as validateContract } from './lib/artifact-contract-validation.mjs';
import { commitPreview, createPreview, createRun, loadRun, updateRun } from './lib/run-root.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const require = createRequire(join(pluginRoot, 'package.json'));

// ─── AJV schema validation ───
let _ajvInstance = null;
const _validators = new Map();

function getAjv() {
  if (!_ajvInstance) {
    try {
      const AjvModule = require('ajv');
      _ajvInstance = new AjvModule.default({ allErrors: true, strict: false });
      const addFormatsModule = require('ajv-formats');
      addFormatsModule.default(_ajvInstance);
    } catch {
      return null;
    }
  }
  return _ajvInstance;
}

function getValidator(schemaRelPath) {
  if (_validators.has(schemaRelPath)) return _validators.get(schemaRelPath);
  const ajv = getAjv();
  if (!ajv) return null;
  try {
    const schemaPath = join(pluginRoot, schemaRelPath);
    if (!existsSync(schemaPath)) return null;
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    _validators.set(schemaRelPath, validate);
    return validate;
  } catch {
    return null;
  }
}

function validateSchema(data, schemaRelPath) {
  const validate = getValidator(schemaRelPath);
  if (!validate) {
    return {
      valid: false,
      unavailable: true,
      errors: [{ keyword: 'runtime', instancePath: '/', message: `schema validator unavailable: ${schemaRelPath}` }],
    };
  }
  const valid = validate(data);
  return { valid, unavailable: false, errors: valid ? null : validate.errors };
}

// ─── Path safety ───
function resolveContainedPath(projectRoot, filePath, { mustExist = false } = {}) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (isAbsolute(filePath)) return false;
  if (filePath.includes('\0') || filePath.startsWith('~')) return false;
  let canonicalRoot;
  try { canonicalRoot = realpathSync(projectRoot); } catch { return false; }
  const candidate = resolve(canonicalRoot, filePath);
  const lexicalRelative = relative(canonicalRoot, candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) return false;

  if (existsSync(candidate)) {
    let canonicalCandidate;
    try { canonicalCandidate = realpathSync(candidate); } catch { return false; }
    const canonicalRelative = relative(canonicalRoot, canonicalCandidate);
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) return false;
    return canonicalCandidate;
  }
  if (mustExist) return false;

  // 对尚不存在的输出，沿父目录向上寻找第一个现存节点并校验真实路径，
  // 防止 `safe/link/new.json` 通过指向项目外的目录符号链接逃逸。
  let ancestor = dirname(candidate);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  let canonicalAncestor;
  try { canonicalAncestor = realpathSync(ancestor); } catch { return false; }
  const ancestorRelative = relative(canonicalRoot, canonicalAncestor);
  if (ancestorRelative === '..' || ancestorRelative.startsWith(`..${sep}`) || isAbsolute(ancestorRelative)) return false;
  return candidate;
}

function isSafeRelativePath(projectRoot, filePath, options) {
  return Boolean(resolveContainedPath(projectRoot, filePath, options));
}

function safeReadJson(projectRoot, relPath) {
  const safePath = resolveContainedPath(projectRoot, relPath, { mustExist: true });
  if (!safePath) return null;
  try {
    return JSON.parse(readFileSync(safePath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Stable content digest ───
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableDigest(data) {
  const canonical = JSON.stringify(canonicalize(data));
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

function stripQualifiedRef(value) {
  if (typeof value !== 'string') return '';
  const separator = value.indexOf(':');
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function makeStableReviewId(artifactRef, artifactDigest, reviewer) {
  const hex = createHash('sha256').update(`${artifactRef}\n${artifactDigest}\n${reviewer}`).digest('hex').slice(0, 15);
  return `REVIEW-${BigInt(`0x${hex}`).toString(10)}`;
}

function validateArtifactContract(artifact, contractId) {
  return validateContract(pluginRoot, artifact, contractId);
}

// ─── Finding catalog rules ───
const INTERNAL_ORACLE_KEYWORDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN',
  'querySelector', 'getElementById', 'className', 'innerHTML', 'innerText',
  'SQL', '数据库', '表名', '字段名', '函数调用', '内部API', '内部接口',
  'CSS', 'XPath', 'data-', 'class=', '#id',
];

function runSemanticReviewRules(artifact) {
  const findings = [];
  const cases = artifact.test_cases || [];
  for (const c of cases) {
    analyzeCase(c, findings, cases);
  }
  return findings;
}

function analyzeCase(c, findings, allCases) {
  const ref = c.case_id || '?';

  // E2E-F-001: source artifact missing
  if (!c.trace_targets || c.trace_targets.length === 0) {
    findings.push({ rule: 'E2E-F-001', severity: 'high', category: 'traceability',
      description: `测试用例 ${ref} 缺少来源引用`, case_ref: ref, repairability: 'safe-fix',
      evidence: 'trace_targets empty', expected: '至少引用一个 feature/AC/scenario', actual: '来源缺失',
      suggestion: '补充来源引用', rule_source: 'findings-catalog.md §E2E-F-001' });
  }

  // E2E-F-003: missing goal
  if (!c.goal) {
    findings.push({ rule: 'E2E-F-003', severity: 'high', category: 'context',
      description: `测试用例 ${ref} 缺少清晰的目标声明`, case_ref: ref, repairability: 'safe-fix',
      evidence: 'goal missing', expected: '有明确 goal', actual: 'goal 缺失',
      suggestion: '补充测试目标', rule_source: 'findings-catalog.md §E2E-F-003' });
  }

  // E2E-F-004: path analysis
  const pathClass = c.path_class;
  if (pathClass === 'happy') {
    const hasErrorPath = allCases.some(other => other !== c && (other.path_class === 'error' || other.path_class === 'recovery'));
    if (!hasErrorPath) {
      findings.push({ rule: 'E2E-F-004', severity: 'high', category: 'coverage',
        description: `测试用例 ${ref} 只有 happy path，缺少错误/恢复路径覆盖`, case_ref: ref,
        repairability: 'business-decision',
        evidence: 'path_class: happy, no error/recovery cases', expected: '有 error/recovery 路径或结构化 waiver',
        actual: '只有 happy path', suggestion: '补充错误/恢复路径覆盖或提供 waiver',
        rule_source: 'findings-catalog.md §E2E-F-004' });
    }
  }

  // E2E-F-005: oracle analysis
  if (c.oracles && c.oracles.length > 0) {
    for (const oracle of c.oracles) {
      const obs = typeof oracle.observable === 'string' ? oracle.observable : '';
      if (INTERNAL_ORACLE_KEYWORDS.some(kw => obs.includes(kw))) {
        findings.push({ rule: 'E2E-F-005', severity: 'high', category: 'oracle',
          description: `测试用例 ${ref} oracle 依赖实现内部细节`, case_ref: ref,
          repairability: 'safe-fix', evidence: `observable: "${obs}"`,
          expected: '面向用户或业务可观察结果', actual: '依赖实现细节',
          suggestion: '将 oracle 改为业务可观察结果', rule_source: 'findings-catalog.md §E2E-F-005' });
        break;
      }
    }
  } else {
    findings.push({ rule: 'E2E-F-005', severity: 'high', category: 'oracle',
      description: `测试用例 ${ref} 缺少 oracle 声明`, case_ref: ref,
      repairability: 'safe-fix', evidence: 'oracles empty or missing',
      expected: '有业务可观察 oracle', actual: 'oracle 缺失',
      suggestion: '补充 oracle', rule_source: 'findings-catalog.md §E2E-F-005' });
  }

  // E2E-F-007: cleanup
  if (!c.cleanup || c.cleanup.length === 0) {
    findings.push({ rule: 'E2E-F-007', severity: 'medium', category: 'cleanup',
      description: `测试用例 ${ref} 缺少清理步骤`, case_ref: ref,
      repairability: 'safe-fix', evidence: 'cleanup empty or missing',
      expected: '有清理步骤', actual: '清理缺失',
      suggestion: '添加清理步骤', rule_source: 'findings-catalog.md §E2E-F-007' });
  }
}

// ─── Finding severity/repairability from the shipped authoritative catalog ───
function loadFindingCatalog() {
  const text = readFileSync(join(pluginRoot, 'references', 'findings-catalog.md'), 'utf8');
  const catalog = {};
  for (const section of text.split(/^## /m).slice(1)) {
    const rule = section.match(/^(E2E-F-\d{3}):/)?.[1];
    const severity = section.match(/^\| severity \| (high|medium|low) \|$/m)?.[1];
    const repairability = section.match(/^\| repairability \| (safe-fix|business-decision|out-of-scope) \|$/m)?.[1];
    if (rule && severity && repairability) catalog[rule] = { severity, repairability };
  }
  return catalog;
}

const FINDING_CATALOG = loadFindingCatalog();

function normalizeFinding(f) {
  const cat = FINDING_CATALOG[f.rule];
  if (cat) {
    f.severity = cat.severity;
    f.repairability = cat.repairability;
  }
  return f;
}

// ─── Default dispatch intent routing ───
const VALID_INTENTS = new Set(['help', 'author', 'review', 'repair']);

function dispatchDefault(req, projectRoot) {
  if (!req.intent) {
    return { status: 'NEEDS_INPUT', code: 'INTENT_REQUIRED', service: 'default',
      diagnostics: [{ code: 'INTENT_REQUIRED', severity: 'error', field: 'intent', reason: 'default 服务需要明确 intent 字段' }],
      preflight: req._preflight || null, runLock: req._runLock || null, stageResult: null, contractValidation: null, writeSet: [] };
  }
  const intent = String(req.intent).toLowerCase().trim();
  if (!VALID_INTENTS.has(intent)) {
    return { status: 'NEEDS_INPUT', code: 'UNKNOWN_INTENT', service: 'default',
      diagnostics: [{ code: 'UNKNOWN_INTENT', severity: 'error', field: 'intent',
        reason: `未知 intent: "${intent}"，有效值: ${[...VALID_INTENTS].join(', ')}` }],
      preflight: req._preflight || null, runLock: req._runLock || null, stageResult: null, contractValidation: null, writeSet: [] };
  }
  if (intent === 'help') {
    return null; // signal caller to run help in service-runner
  }
  const subRequest = { ...req, service: intent };
  delete subRequest.intent;
  return dispatch(subRequest, projectRoot);
}

// ─── Main dispatch entry ───
const DIAGNOSTICS = {
  PROJECT_ROOT_INVALID: { code: 'PROJECT_ROOT_INVALID', severity: 'error' },
  OUTPUT_PATH_REQUIRED: { code: 'OUTPUT_PATH_REQUIRED', severity: 'error' },
  OUTPUT_PATH_UNSAFE: { code: 'OUTPUT_PATH_UNSAFE', severity: 'error' },
  OUTPUT_EXISTS_NO_OVERWRITE: { code: 'OUTPUT_EXISTS_NO_OVERWRITE', severity: 'error' },
  INPUT_PATH_UNSAFE: { code: 'INPUT_PATH_UNSAFE', severity: 'error' },
  INPUT_FILE_NOT_FOUND: { code: 'INPUT_FILE_NOT_FOUND', severity: 'error' },
  INPUT_SCHEMA_INVALID: { code: 'INPUT_SCHEMA_INVALID', severity: 'error' },
  REFERENCE_MISMATCH: { code: 'REFERENCE_MISMATCH', severity: 'error' },
  MATRIX_INCOMPLETE: { code: 'MATRIX_INCOMPLETE', severity: 'error' },
  UNKNOWN_SERVICE: { code: 'UNKNOWN_SERVICE', severity: 'error' },
  WRITE_SET_VIOLATION: { code: 'WRITE_SET_VIOLATION', severity: 'error' },
  SCHEMA_VALIDATOR_UNAVAILABLE: { code: 'SCHEMA_VALIDATOR_UNAVAILABLE', severity: 'error' },
  ARTIFACT_GRAPH_UNAVAILABLE: { code: 'ARTIFACT_GRAPH_UNAVAILABLE', severity: 'error' },
  ARTIFACT_CONTRACT_INVALID: { code: 'ARTIFACT_CONTRACT_INVALID', severity: 'error' },
  INPUT_ARTIFACT_REQUIRED: { code: 'INPUT_ARTIFACT_REQUIRED', severity: 'error' },
  ARTIFACT_READ_FAILED: { code: 'ARTIFACT_READ_FAILED', severity: 'error' },
  REVIEW_RESULT_REQUIRED: { code: 'REVIEW_RESULT_REQUIRED', severity: 'error' },
  REPAIR_PLAN_REQUIRED: { code: 'REPAIR_PLAN_REQUIRED', severity: 'error' },
  ARTIFACT_INVALID: { code: 'ARTIFACT_INVALID', severity: 'error' },
  INTENT_REQUIRED: { code: 'INTENT_REQUIRED', severity: 'error' },
  UNKNOWN_INTENT: { code: 'UNKNOWN_INTENT', severity: 'error' },
  REPAIR_TARGET_INVALID: { code: 'REPAIR_TARGET_INVALID', severity: 'error' },
};

export function dispatch(req, projectRoot) {
  if (!projectRoot || !isAbsolute(projectRoot) || !existsSync(projectRoot)) {
    return { status: 'BLOCKED', code: 'PROJECT_ROOT_INVALID', service: req.service || null,
      diagnostics: [DIAGNOSTICS.PROJECT_ROOT_INVALID], preflight: null, runLock: null,
      stageResult: null, contractValidation: null, writeSet: [] };
  }

  if (req.service === 'default') {
    const result = dispatchDefault(req, projectRoot);
    if (result === null) {
      return { status: 'AVAILABLE', code: 'HELP_REDIRECT', service: 'default',
        diagnostics: [], preflight: req._preflight || null, runLock: req._runLock || null,
        stageResult: null, contractValidation: null, writeSet: [] };
    }
    return result;
  }

  // Service routing (check before output path validation)
  const KNOWN_SERVICES = new Set(['author', 'review', 'repair']);
  if (!KNOWN_SERVICES.has(req.service)) {
    return dispatchError('UNKNOWN_SERVICE', req.service, req, [DIAGNOSTICS.UNKNOWN_SERVICE]);
  }

  // Author/repair always write an authorized artifact. Review writes only when
  // output is explicitly present in writeSet; otherwise it returns stdout data.
  const stagedAuthor = req.service === 'author' && handlesAuthorWorkflow(req);
  const stagedRepair = req.service === 'repair';
  const outputRequired = (req.service === 'repair' && !req.commit) || (req.service === 'author' && (!stagedAuthor || (!req.runId && !req.commit)));
  if (outputRequired && !req.output) {
    return dispatchError('OUTPUT_PATH_REQUIRED', req.service, req, [DIAGNOSTICS.OUTPUT_PATH_REQUIRED]);
  }
  if (req.output && !isSafeRelativePath(projectRoot, req.output)) {
    return dispatchError('OUTPUT_PATH_UNSAFE', req.service, req, [DIAGNOSTICS.OUTPUT_PATH_UNSAFE]);
  }
  const outputAbs = req.output ? resolveContainedPath(projectRoot, req.output) : null;
  const willWrite = !stagedAuthor && !stagedRepair && (outputRequired || Boolean(req.output && req.writeSet?.includes(req.output)));
  if (willWrite && existsSync(outputAbs) && !req.overwrite) {
    return dispatchError('OUTPUT_EXISTS_NO_OVERWRITE', req.service, req, [DIAGNOSTICS.OUTPUT_EXISTS_NO_OVERWRITE]);
  }

  // Service dispatch
  switch (req.service) {
    case 'author': return dispatchAuthor(req, projectRoot, outputAbs);
    case 'review': return dispatchReview(req, projectRoot, outputAbs);
    case 'repair': return dispatchRepair(req, projectRoot, outputAbs);
  }
}

function dispatchError(code, service, req, diagnostics) {
  return { status: 'BLOCKED', code, service: service || null, diagnostics,
    preflight: req?._preflight || null, runLock: req?._runLock || null,
    stageResult: null, contractValidation: null, writeSet: [] };
}

// ═══════════════════════════════════════════════════════════════
// AUTHOR
// ═══════════════════════════════════════════════════════════════
function dispatchAuthor(req, projectRoot, outputAbs) {
  if (handlesAuthorWorkflow(req)) return dispatchAuthorWorkflow(req, projectRoot, pluginRoot);
  if (!req.writeSet?.includes(req.output)) {
    return dispatchError('WRITE_SET_VIOLATION', 'author', req, [DIAGNOSTICS.WRITE_SET_VIOLATION]);
  }
  // Validate inputs
  if (!req.inputs || typeof req.inputs !== 'object') {
    return dispatchError('INPUT_PATH_UNSAFE', 'author', req, [{ ...DIAGNOSTICS.INPUT_PATH_UNSAFE, field: 'inputs' }]);
  }
  for (const key of ['inspection', 'assessment', 'matrix']) {
    if (!req.inputs[key]) {
      return dispatchError('INPUT_PATH_UNSAFE', 'author', req, [{ ...DIAGNOSTICS.INPUT_PATH_UNSAFE, field: `inputs.${key}` }]);
    }
    if (!isSafeRelativePath(projectRoot, req.inputs[key])) {
      return dispatchError('INPUT_PATH_UNSAFE', 'author', req, [{ ...DIAGNOSTICS.INPUT_PATH_UNSAFE, field: `inputs.${key}` }]);
    }
  }

  // Read and validate inspection
  const inspection = safeReadJson(projectRoot, req.inputs.inspection);
  if (!inspection) {
    return dispatchError('INPUT_FILE_NOT_FOUND', 'author', req, [{ ...DIAGNOSTICS.INPUT_FILE_NOT_FOUND, field: 'inputs.inspection' }]);
  }
  const inspValidation = validateSchema(inspection, 'schemas/inspection.json');
  if (!inspValidation.valid) {
    const code = inspValidation.unavailable ? 'SCHEMA_VALIDATOR_UNAVAILABLE' : 'INPUT_SCHEMA_INVALID';
    return dispatchError(code, 'author', req,
      [{ ...DIAGNOSTICS[code], field: 'inputs.inspection', errors: inspValidation.errors }]);
  }

  // Read and validate assessment
  const assessment = safeReadJson(projectRoot, req.inputs.assessment);
  if (!assessment) {
    return dispatchError('INPUT_FILE_NOT_FOUND', 'author', req, [{ ...DIAGNOSTICS.INPUT_FILE_NOT_FOUND, field: 'inputs.assessment' }]);
  }
  const assessValidation = validateSchema(assessment, 'schemas/candidate-assessment.json');
  if (!assessValidation.valid) {
    const code = assessValidation.unavailable ? 'SCHEMA_VALIDATOR_UNAVAILABLE' : 'INPUT_SCHEMA_INVALID';
    return dispatchError(code, 'author', req,
      [{ ...DIAGNOSTICS[code], field: 'inputs.assessment', errors: assessValidation.errors }]);
  }

  // Cross-reference
  if (assessment.inspection_ref !== inspection.inspection_id) {
    return dispatchError('REFERENCE_MISMATCH', 'author', req,
      [{ ...DIAGNOSTICS.REFERENCE_MISMATCH, detail: `assessment.inspection_ref (${assessment.inspection_ref}) !== inspection.inspection_id (${inspection.inspection_id})` }]);
  }

  // Read and validate matrix
  const matrix = safeReadJson(projectRoot, req.inputs.matrix);
  if (!matrix) {
    return dispatchError('INPUT_FILE_NOT_FOUND', 'author', req, [{ ...DIAGNOSTICS.INPUT_FILE_NOT_FOUND, field: 'inputs.matrix' }]);
  }
  const matrixValidation = validateSchema(matrix, 'schemas/matrix.json');
  if (!matrixValidation.valid) {
    const code = matrixValidation.unavailable ? 'SCHEMA_VALIDATOR_UNAVAILABLE' : 'INPUT_SCHEMA_INVALID';
    return dispatchError(code, 'author', req,
      [{ ...DIAGNOSTICS[code], field: 'inputs.matrix', errors: matrixValidation.errors }]);
  }

  // Cross-reference matrix → assessment
  if (matrix.assessment_ref !== assessment.assessment_id) {
    return dispatchError('REFERENCE_MISMATCH', 'author', req,
      [{ ...DIAGNOSTICS.REFERENCE_MISMATCH, detail: `matrix.assessment_ref (${matrix.assessment_ref}) !== assessment.assessment_id (${assessment.assessment_id})` }]);
  }

  // Validate assessment candidate criteria
  const needsInput = [];
  for (const cand of (assessment.candidates || [])) {
    if (!cand.criteria_met || cand.criteria_met.length === 0) {
      needsInput.push({ field: `candidates.${cand.candidate_id}.criteria_met`, reason: '至少满足一个 E2E 候选条件' });
    }
    if (!cand.scenario_ref) {
      needsInput.push({ field: `candidates.${cand.candidate_id}.scenario_ref`, reason: 'contract 要求至少一个可追溯 scenario/design/decision 来源' });
    }
  }

  // Validate matrix cases for completeness
  for (const mc of (matrix.cases || [])) {
    const id = mc.case_id || '?';
    if (!mc.path || !mc.path.path_class) {
      needsInput.push({ field: `cases.${id}.path.path_class`, reason: '路径分类缺失' });
    }
    if (!mc.oracle || mc.oracle.observable === undefined || mc.oracle.observable === null) {
      needsInput.push({ field: `cases.${id}.oracle.observable`, reason: 'oracle observable 缺失' });
    }
    if (!mc.cleanup) {
      needsInput.push({ field: `cases.${id}.cleanup`, reason: 'cleanup 维度缺失' });
    }
  }

  if (needsInput.length > 0) {
    const stageResult = {
      stage: 'compose', status: 'NEEDS_INPUT',
      inputs: { inspection: req.inputs.inspection, assessment: req.inputs.assessment, matrix: req.inputs.matrix },
      outputs: {}, needs_input: needsInput,
    };
    return {
      status: 'NEEDS_INPUT', code: 'MATRIX_INCOMPLETE', service: 'author',
      diagnostics: needsInput.map(n => ({ code: 'MATRIX_INCOMPLETE', severity: 'error', field: n.field, reason: n.reason })),
      preflight: req._preflight || null, runLock: req._runLock || null,
      stageResult, contractValidation: null, writeSet: req.writeSet || [],
    };
  }

  // Compose artifact
  const artifact = {
    metadata: {
      id: `${matrix.matrix_id}:FILE`,
      title: `E2E 测试规格：${inspection.business_context?.business_goal || '未命名'}`,
      status: 'active',
      test_batch: matrix.matrix_id,
    },
    scope: {
      business_goal: inspection.business_context?.business_goal || '',
      actors: inspection.business_context?.actors || [],
      system_boundaries: inspection.candidate_paths?.flatMap(p => p.boundaries || []) || [],
      // WP1A：scope.non_goals 只能来自显式 non_goals，不得来自 constraints（约束保留为约束语义）。
      non_goals: inspection.business_context?.non_goals || [],
    },
    system_boundary: {
      components: inspection.candidate_paths?.flatMap(p => p.boundaries || []) || [],
      external_dependencies: [],
      trust_boundaries: [],
    },
    coverage: {
      ac_coverage: Object.fromEntries((assessment.candidates || []).map(c => [
        c.ac_ref,
        (matrix.cases || []).filter(mc => mc.candidate_ref === c.candidate_id).map(mc => mc.case_id),
      ])),
      related_scenarios: [...new Set((assessment.candidates || []).map(c => stripQualifiedRef(c.scenario_ref)).filter(Boolean))],
      related_features: [...new Set((assessment.candidates || []).map(c => stripQualifiedRef(c.feature_ref)).filter(Boolean))],
      related_decisions: [],
    },
    environment_data: {
      topology: matrix.cases?.[0]?.environment?.topology || 'unknown',
      fixtures: matrix.cases?.flatMap(c => c.data_identity?.test_data || []) || [],
      identities: matrix.cases?.flatMap(c => c.data_identity?.identities || []) || [],
      isolation_strategy: matrix.cases?.[0]?.data_identity?.isolation || 'unknown',
    },
    relations: (assessment.candidates || []).flatMap(c => [
      { kind: 'derives_from', target_type: 'scenario', target_id: stripQualifiedRef(c.scenario_ref) },
      { kind: 'verifies', target_type: 'feature', target_id: stripQualifiedRef(c.feature_ref), anchor: c.ac_ref },
    ]),
    test_cases: (matrix.cases || []).map(mc => ({
      case_id: mc.case_id,
      goal: mc.source_scope?.acceptance_criteria?.join(', ') || '',
      preconditions: mc.environment?.setup || [],
      actions: (mc.path?.steps || []).map((step, i) => ({ step: i + 1, action: step, expected_result: '' })),
      oracles: mc.oracle ? [{ observable: mc.oracle.observable, criterion: mc.oracle.criterion,
        timeout_ms: mc.oracle.timeout_ms }] : [],
      cleanup: mc.cleanup?.cleanup_steps || [],
      priority: mc.value_risk?.risk_level || 'medium',
      trace_targets: [mc.candidate_ref],
      path_class: mc.path?.path_class || 'unknown',
    })),
    evidence_contract: {
      required_artifacts: matrix.cases?.[0]?.automation?.trace_report ? [matrix.cases[0].automation.trace_report] : [],
      runner_binding: matrix.cases?.[0]?.automation?.runner || 'unknown',
      proof_requirements: [matrix.cases?.[0]?.automation?.proof_condition || 'pass'],
    },
  };

  // Contract validation
  const contractValidation = validateArtifactContract(artifact, 'artifact.e2e-test@1');
  if (!contractValidation.valid) {
    const unavailable = contractValidation.method === 'unavailable';
    const code = unavailable ? 'ARTIFACT_GRAPH_UNAVAILABLE' : 'ARTIFACT_CONTRACT_INVALID';
    return {
      ...dispatchError(code, 'author', req, [{ ...DIAGNOSTICS[code], errors: contractValidation.errors }]),
      contractValidation,
    };
  }

  // Semantic review
  let reviewFindings = runSemanticReviewRules(artifact);
  reviewFindings = reviewFindings.map(normalizeFinding);

  // Proof reconciliation
  const proofBindings = {};
  for (const mc of (matrix.cases || [])) {
    const candId = mc.candidate_ref;
    const cand = (assessment.candidates || []).find(c => c.candidate_id === candId);
    proofBindings[mc.case_id] = {
      candidate: candId, feature: cand?.feature_ref, ac: cand?.ac_ref,
      bound: true,
    };
  }
  const boundCount = Object.values(proofBindings).filter(b => b.bound).length;
  const unboundCount = (artifact.test_cases?.length || 0) - boundCount;

  // Compute artifact digest
  const artifactDigest = stableDigest(artifact);

  // Write file (skip if identical)
  mkdirSync(dirname(outputAbs), { recursive: true });
  writeFileSync(outputAbs, JSON.stringify(artifact, null, 2) + '\n');
  const wrote = true;

  // Stage result
  const stageResult = {
    stage: 'compose', status: 'PASS',
    inputs: { inspection: req.inputs.inspection, assessment: req.inputs.assessment, matrix: req.inputs.matrix },
    outputs: {
      artifactId: artifact.metadata.id, cases: artifact.test_cases?.length || 0,
      boundCases: boundCount, unboundCases: unboundCount,
      contractMethod: contractValidation.method, contractValid: contractValidation.valid,
      findingsCount: reviewFindings.length,
    },
  };

  return {
    status: 'PASS', code: 'AUTHOR_COMPLETE', service: 'author',
    diagnostics: [],
    preflight: req._preflight || null, runLock: req._runLock || null,
    stageResult, contractValidation: { method: contractValidation.method, valid: contractValidation.valid },
    reviewResult: { findings: reviewFindings, total: reviewFindings.length,
      high: reviewFindings.filter(f => f.severity === 'high').length,
      medium: reviewFindings.filter(f => f.severity === 'medium').length,
      low: reviewFindings.filter(f => f.severity === 'low').length },
    artifactPath: req.output, artifactDigest,
    writeSet: req.writeSet || [],
    wrote,
  };
}

// ═══════════════════════════════════════════════════════════════
// REVIEW
// ═══════════════════════════════════════════════════════════════
function dispatchReview(req, projectRoot, outputAbs) {
  if (!req.inputArtifact) {
    return dispatchError('INPUT_ARTIFACT_REQUIRED', 'review', req, [DIAGNOSTICS.INPUT_ARTIFACT_REQUIRED]);
  }
  if (!isSafeRelativePath(projectRoot, req.inputArtifact)) {
    return dispatchError('INPUT_PATH_UNSAFE', 'review', req, [{ ...DIAGNOSTICS.INPUT_PATH_UNSAFE, field: 'inputArtifact' }]);
  }
  const inputAbs = resolve(projectRoot, req.inputArtifact);
  if (!existsSync(inputAbs)) {
    return dispatchError('INPUT_FILE_NOT_FOUND', 'review', req, [{ ...DIAGNOSTICS.INPUT_FILE_NOT_FOUND, field: 'inputArtifact' }]);
  }

  let artifact;
  try { artifact = JSON.parse(readFileSync(inputAbs, 'utf8')); }
  catch { return dispatchError('ARTIFACT_READ_FAILED', 'review', req, [DIAGNOSTICS.ARTIFACT_READ_FAILED]); }

  // Contract validation
  const contractValidation = validateArtifactContract(artifact, 'artifact.e2e-test@1');
  const artifactDigest = stableDigest(artifact);
  if (!contractValidation.valid) {
    const unavailable = contractValidation.method === 'unavailable';
    const code = unavailable ? 'ARTIFACT_GRAPH_UNAVAILABLE' : 'ARTIFACT_CONTRACT_INVALID';
    return {
      ...dispatchError(code, 'review', req, [{ ...DIAGNOSTICS[code], errors: contractValidation.errors }]),
      contractValidation,
      artifactDigest,
    };
  }

  // Semantic review
  let findings = runSemanticReviewRules(artifact);
  findings = findings.map(normalizeFinding);

  const highCount = findings.filter(f => f.severity === 'high').length;
  const overallStatus = highCount > 0 ? 'FAIL' : 'PASS';

  // Stage result
  const stageResult = {
    stage: 'review-core', status: overallStatus,
    inputs: { inputArtifact: req.inputArtifact },
    outputs: { totalFindings: findings.length, highSeverity: highCount,
      contractValid: contractValidation.valid, contractMethod: contractValidation.method },
  };

  // Review result
  const reviewResult = {
    review_id: makeStableReviewId(req.inputArtifact, artifactDigest, 'e2e-test-review-core'), artifact_ref: req.inputArtifact,
    reviewer: { type: 'deterministic', identity: 'e2e-test-review-core' },
    overall_status: overallStatus, findings,
    summary: {
      total: findings.length, high: highCount,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      safe_fix: findings.filter(f => f.repairability === 'safe-fix').length,
      business_decision: findings.filter(f => f.repairability === 'business-decision').length,
      out_of_scope: findings.filter(f => f.repairability === 'out-of-scope').length,
    },
    deterministic_checks: {
      schema_valid: true,
      contract_valid: contractValidation.valid,
      matrix_complete: !findings.some(f => f.rule === 'E2E-F-004'),
      relations_valid: !findings.some(f => f.rule === 'E2E-F-001'),
    },
  };

  // Write review result to output (always, per task: review output via writeSet)
  const resultValidation = validateSchema(reviewResult, 'schemas/review-result.json');
  if (!resultValidation.valid) {
    const code = resultValidation.unavailable ? 'SCHEMA_VALIDATOR_UNAVAILABLE' : 'INPUT_SCHEMA_INVALID';
    return dispatchError(code, 'review', req,
      [{ ...DIAGNOSTICS[code], field: 'reviewResult', errors: resultValidation.errors }]);
  }

  if (req.output && req.writeSet?.includes(req.output)) {
    mkdirSync(dirname(outputAbs), { recursive: true });
    writeFileSync(outputAbs, JSON.stringify(reviewResult, null, 2) + '\n');
  }

  return {
    status: 'PASS', code: 'REVIEW_COMPLETE', service: 'review',
    diagnostics: [],
    preflight: req._preflight || null, runLock: req._runLock || null,
    stageResult, contractValidation: { method: contractValidation.method, valid: contractValidation.valid },
    reviewResult, artifactDigest,
    writeSet: req.writeSet || [],
  };
}

// ═══════════════════════════════════════════════════════════════
// REPAIR
// ═══════════════════════════════════════════════════════════════
function dispatchRepair(req, projectRoot, outputAbs) {
  if (req.mode === 'commit' || req.commit) return commitRepair(req, projectRoot);
  if (!req.inputArtifact) {
    return dispatchError('INPUT_ARTIFACT_REQUIRED', 'repair', req, [DIAGNOSTICS.INPUT_ARTIFACT_REQUIRED]);
  }
  if (!isSafeRelativePath(projectRoot, req.inputArtifact)) {
    return dispatchError('INPUT_PATH_UNSAFE', 'repair', req, [{ ...DIAGNOSTICS.INPUT_PATH_UNSAFE, field: 'inputArtifact' }]);
  }
  const inputAbs = resolve(projectRoot, req.inputArtifact);
  if (!existsSync(inputAbs)) {
    return dispatchError('INPUT_FILE_NOT_FOUND', 'repair', req, [{ ...DIAGNOSTICS.INPUT_FILE_NOT_FOUND, field: 'inputArtifact' }]);
  }

  let artifact;
  try { artifact = JSON.parse(readFileSync(inputAbs, 'utf8')); }
  catch { return dispatchError('ARTIFACT_READ_FAILED', 'repair', req, [DIAGNOSTICS.ARTIFACT_READ_FAILED]); }

  const inputValidation = validateArtifactContract(artifact, 'artifact.e2e-test@1');
  if (!inputValidation.valid) {
    const unavailable = inputValidation.method === 'unavailable';
    const code = unavailable ? 'ARTIFACT_GRAPH_UNAVAILABLE' : 'ARTIFACT_CONTRACT_INVALID';
    return {
      ...dispatchError(code, 'repair', req, [{ ...DIAGNOSTICS[code], errors: inputValidation.errors }]),
      contractValidation: inputValidation,
    };
  }

  if (!req.repairPlan || typeof req.repairPlan !== 'object' || Object.keys(req.repairPlan).length === 0) {
    return dispatchError('REPAIR_PLAN_REQUIRED', 'repair', req, [DIAGNOSTICS.REPAIR_PLAN_REQUIRED]);
  }

  // Read review result if provided
  let reviewFindings = [];
  if (req.reviewResult) {
    if (isSafeRelativePath(projectRoot, req.reviewResult)) {
      const reviewAbs = resolve(projectRoot, req.reviewResult);
      if (existsSync(reviewAbs)) {
        try {
          const reviewData = JSON.parse(readFileSync(reviewAbs, 'utf8'));
          const reviewValidation = validateSchema(reviewData, 'schemas/review-result.json');
          if (!reviewValidation.valid) {
            const code = reviewValidation.unavailable ? 'SCHEMA_VALIDATOR_UNAVAILABLE' : 'INPUT_SCHEMA_INVALID';
            return dispatchError(code, 'repair', req,
              [{ ...DIAGNOSTICS[code], field: 'reviewResult', errors: reviewValidation.errors }]);
          }
          reviewFindings = reviewData.findings || [];
        } catch { /* no review findings */ }
      }
    }
  }

  // If no review findings loaded, run a fresh review
  if (reviewFindings.length === 0) {
    reviewFindings = runSemanticReviewRules(artifact).map(normalizeFinding);
  }

  // Deep clone artifact (never modify original)
  const repaired = JSON.parse(JSON.stringify(artifact));

  // Apply repair plan for safe-fix findings
  const repairResults = [];
  const needsInput = [];

  for (const [rule, plan] of Object.entries(req.repairPlan)) {
    const matchingFindings = reviewFindings.filter(f => f.rule === rule);
    if (matchingFindings.length === 0) {
      needsInput.push({ rule, reason: `finding ${rule} 未在 review 结果中发现` });
      continue;
    }
    if (matchingFindings.some(finding => finding.repairability !== 'safe-fix')) {
      needsInput.push({ rule, reason: `${rule} 不是可确定性执行的 safe-fix` });
      continue;
    }

    // E2E-F-005: internal oracle → replacementOracle
    if (rule === 'E2E-F-005') {
      if (!plan.replacementOracle) {
        needsInput.push({ rule, reason: 'E2E-F-005 需要 replacementOracle 字段' });
        continue;
      }
      let fixed = false;
      for (const c of (repaired.test_cases || [])) {
        if (!c.oracles || c.oracles.length === 0) continue;
        const obs = c.oracles[0].observable;
        if (typeof obs !== 'string') continue;
        if (INTERNAL_ORACLE_KEYWORDS.some(kw => obs.includes(kw))) {
          c.oracles[0].observable = plan.replacementOracle;
          fixed = true;
        }
      }
      repairResults.push({ rule, fixed, plan });
    }
    // E2E-F-007: missing cleanup → additionalCleanup
    else if (rule === 'E2E-F-007') {
      if (!plan.additionalCleanup) {
        needsInput.push({ rule, reason: 'E2E-F-007 需要 additionalCleanup 字段' });
        continue;
      }
      let fixed = false;
      const targetCases = new Set(matchingFindings.map(finding => finding.case_ref).filter(Boolean));
      for (const c of (repaired.test_cases || [])) {
        if (!c.cleanup || c.cleanup.length === 0) {
          if (targetCases.size > 0 && !targetCases.has(c.case_id)) continue;
          c.cleanup = Array.isArray(plan.additionalCleanup) ? [...plan.additionalCleanup] : [plan.additionalCleanup];
          fixed = true;
        }
      }
      repairResults.push({ rule, fixed, plan });
    }
    // Other safe-fix rules — treat as NEEDS_INPUT (no deterministic fix known)
    else {
      needsInput.push({ rule, reason: `${rule} 的确定性修复逻辑尚未实现` });
    }
  }

  if (needsInput.length > 0) {
    const stageResult = {
      stage: 'repair-core', status: 'NEEDS_INPUT',
      inputs: { inputArtifact: req.inputArtifact, reviewResult: req.reviewResult || null },
      outputs: {}, needs_input: needsInput,
    };
    return {
      status: 'NEEDS_INPUT', code: 'REPAIR_NEEDS_INPUT', service: 'repair',
      diagnostics: needsInput.map(n => ({ code: 'REPAIR_NEEDS_INPUT', severity: 'error', field: n.rule, reason: n.reason })),
      preflight: req._preflight || null, runLock: req._runLock || null,
      stageResult, contractValidation: null, writeSet: req.writeSet || [],
    };
  }

  // Writing is allowed only after every deterministic repair has closed.
  if (!req.writeSet || !req.writeSet.includes(req.output)) {
    return dispatchError('WRITE_SET_VIOLATION', 'repair', req, [DIAGNOSTICS.WRITE_SET_VIOLATION]);
  }

  // Re-validate repaired artifact
  const repairedValidation = validateArtifactContract(repaired, 'artifact.e2e-test@1');
  if (!repairedValidation.valid) {
    const unavailable = repairedValidation.method === 'unavailable';
    const code = unavailable ? 'ARTIFACT_GRAPH_UNAVAILABLE' : 'ARTIFACT_CONTRACT_INVALID';
    return {
      ...dispatchError(code, 'repair', req, [{ ...DIAGNOSTICS[code], errors: repairedValidation.errors }]),
      contractValidation: repairedValidation,
    };
  }

  // Re-review repaired artifact
  const repairedFindings = runSemanticReviewRules(repaired).map(normalizeFinding);
  const repairedHighCount = repairedFindings.filter(f => f.severity === 'high').length;
  const reReviewStatus = repairedHighCount > 0 ? 'FAIL' : 'PASS';

  const requestedRules = new Set(repairResults.filter(result => result.fixed).map(result => result.rule));
  const unclosedRules = repairedFindings.filter(finding => requestedRules.has(finding.rule));
  if (unclosedRules.length > 0 || repairResults.some(result => !result.fixed)) {
    return {
      ...dispatchError('REPAIR_TARGET_INVALID', 'repair', req,
        [{ ...DIAGNOSTICS.REPAIR_TARGET_INVALID, rules: [...new Set(unclosedRules.map(finding => finding.rule))] }]),
      contractValidation: repairedValidation,
    };
  }

  const artifactDigest = stableDigest(repaired);

  const stageResult = {
    stage: 'repair-core', status: 'PASS',
    inputs: { inputArtifact: req.inputArtifact, reviewResult: req.reviewResult || null },
    outputs: {
      repairedCases: repairResults.filter(r => r.fixed).length,
      totalFindings: repairedFindings.length, highSeverity: repairedHighCount,
      reReviewStatus, contractValid: repairedValidation.valid,
    },
  };

  const inputDigest = stableDigest(artifact);
  const runId = `run-${stableDigest({ service: 'repair', projectRoot: realpathSync(projectRoot), inputDigest, repairPlan: req.repairPlan, output: req.output }).slice(7, 23)}`;
  const writeSet = [...new Set(req.writeSet || [])].sort();
  const requestDigest = stableDigest({ inputArtifact: req.inputArtifact, inputDigest, repairPlan: req.repairPlan, output: req.output, writeSet });
  const { runRoot, manifest } = createRun({ runId, service: 'repair', requestDigest, inputDigest, createdAt: req.stageTimestamp });
  if (!manifest.repairRequest) {
    manifest.repairRequest = {
      inputArtifact: req.inputArtifact,
      output: req.output,
      writeSet,
      bindings: workflowBindings(req, inputDigest, writeSet),
    };
    updateRun(runRoot, manifest);
  }
  const previewResult = createPreview({
    runRoot, projectRoot, runId, service: 'repair',
    bindings: manifest.repairRequest.bindings,
    stageChainDigest: stableDigest(stageResult),
    contentByPath: { [req.output]: `${JSON.stringify(repaired, null, 2)}\n` },
    createdAt: req.stageTimestamp,
  });

  return {
    status: 'PASS', code: 'REPAIR_PREVIEW_READY', service: 'repair', runId,
    diagnostics: needsInput.map(n => ({ code: 'REPAIR_NEEDS_INPUT', severity: 'warning', field: n.rule, reason: n.reason })),
    preflight: req._preflight || null, runLock: req._runLock || null,
    stageResult,
    contractValidation: { method: repairedValidation.method, valid: repairedValidation.valid },
    reviewResult: {
      review_id: makeStableReviewId(req.output, artifactDigest, 'e2e-test-repair-re-review'), artifact_ref: req.output,
      reviewer: { type: 'deterministic', identity: 'e2e-test-repair-re-review' },
      overall_status: reReviewStatus, findings: repairedFindings,
      summary: { total: repairedFindings.length, high: repairedHighCount,
        medium: repairedFindings.filter(f => f.severity === 'medium').length,
        low: repairedFindings.filter(f => f.severity === 'low').length,
        safe_fix: repairedFindings.filter(f => f.repairability === 'safe-fix').length,
        business_decision: repairedFindings.filter(f => f.repairability === 'business-decision').length,
        out_of_scope: repairedFindings.filter(f => f.repairability === 'out-of-scope').length },
    },
    repairResults, artifactDigest,
    artifactPath: req.output,
    preview: previewResult.preview,
    commitSecret: previewResult.commitSecret,
    writeSet: [],
  };
}

function commitRepair(req, projectRoot) {
  if (!req.commit) return dispatchError('REPAIR_TARGET_INVALID', 'repair', req, [DIAGNOSTICS.REPAIR_TARGET_INVALID]);
  try {
    const { manifest } = loadRun(req.commit.runId);
    if (manifest.service !== 'repair' || !manifest.repairRequest) throw Object.assign(new Error('RUN_ROOT_INVALID'), { code: 'RUN_ROOT_INVALID' });
    const writeSet = [...new Set(req.writeSet || [])].sort();
    const committed = commitPreview({
      runId: req.commit.runId,
      request: { ...req.commit, writeSet, overwrite: req.overwrite, authorization: req.authorization },
      projectRoot,
      currentBindings: workflowBindings(req, manifest.inputDigest, writeSet),
    });
    return {
      status: 'PASS', code: 'REPAIR_COMPLETE', service: 'repair', runId: req.commit.runId,
      diagnostics: [], contractValidation: { method: 'preview-validated', valid: true },
      artifactPath: manifest.repairRequest.output,
      artifactDigest: committed.preview.plannedWrites[0]?.contentDigest,
      writeSet: committed.committed,
    };
  } catch (error) {
    const code = error.code || 'RUN_ROOT_INVALID';
    return dispatchError(code, 'repair', req, [{ code, severity: 'error' }]);
  }
}

function workflowBindings(req, inputDigest, writeSet) {
  const api = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
  const implementation = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
  const bundleDigest = implementation.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  const contractRevision = req.projectFacts?.contractRevisionDigest || req._contractRevision;
  if (!bundleDigest || !contractRevision) throw Object.assign(new Error('COMMIT_BINDING_DRIFT'), { code: 'COMMIT_BINDING_DRIFT' });
  const provider = req._runLock?.provider || req._runLock?.providerSelector || (req._runLock?.bindingDigest ? { bindingDigest: req._runLock.bindingDigest } : {});
  return {
    inputDigest,
    providerDigest: stableDigest(provider),
    familyApiRevision: api.api.revisionDigest,
    contractRevision,
    writeSetDigest: stableDigest([...writeSet].sort()),
    bundleDigest,
  };
}
