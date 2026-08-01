import { createHash } from 'node:crypto';

export const MATRIX_DTO_SCHEMA_ID = 'e2e-test/matrix/v1';
export const MATRIX_DTO_VERSION = '1.0';

export const MATRIX_FIELD_MANIFEST = Object.freeze([
  Object.freeze({ dimension: 'value-risk', fields: ['value_risk'], artifactFields: ['priority'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'source-scope', fields: ['source_scope'], artifactFields: ['relations', 'trace_targets'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'actor-goal-path', fields: ['actor_goal', 'path.cross_boundary'], artifactFields: ['goal', 'system_boundary'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'path-classification', fields: ['path.path_class', 'path.negative_check', 'path.steps'], artifactFields: ['path_class', 'actions'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'oracle', fields: ['oracle'], artifactFields: ['oracles'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'data-identity', fields: ['data_identity', 'environment'], artifactFields: ['environment_data', 'preconditions'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'cleanup', fields: ['cleanup'], artifactFields: ['cleanup'], authoritative: 'matrix' }),
  Object.freeze({ dimension: 'automation', fields: ['automation'], artifactFields: ['evidence_contract', 'implemented_by'], authoritative: 'matrix' }),
]);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function unique(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null && value !== ''))];
}

function stripQualifiedRef(value) {
  if (typeof value !== 'string') return value;
  const separator = value.indexOf(':');
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const TRUST_BOUNDARY_CONSTRAINT = /(?:敏感|隐私|个人信息|商业信息|保密|机密|凭据|密钥|令牌|授权|越权|权限|信任边界|sensitive|privacy|personal\s+data|\bpii\b|secret|credential|\btoken\b|authorization|permission|trust\s+boundary)/i;

export function deriveTrustBoundaries(inspection) {
  return unique((inspection?.business_context?.constraints || [])
    .filter(item => typeof item === 'string' && TRUST_BOUNDARY_CONSTRAINT.test(item)));
}

export function projectOracle(matrixOracle) {
  const negative = typeof matrixOracle?.negative_check === 'string' ? matrixOracle.negative_check.trim() : '';
  return {
    observable: matrixOracle.observable,
    criterion: negative ? `${matrixOracle.criterion}；负向不变量：${negative}` : matrixOracle.criterion,
    ...(matrixOracle.timeout_ms === undefined ? {} : { timeout_ms: matrixOracle.timeout_ms }),
  };
}

export function serializeMatrix(matrix) {
  return JSON.stringify(canonicalize(matrix));
}

export function matrixDigest(matrix) {
  return `sha256:${createHash('sha256').update(serializeMatrix(matrix)).digest('hex')}`;
}

export function projectCaseToArtifact(matrix, matrixCase) {
  if (!matrixCase || !matrix?.cases?.some(item => item.case_id === matrixCase.case_id)) {
    throw new TypeError('matrixCase must be a member of matrix.cases');
  }
  const cleanup = [
    ...(matrixCase.cleanup.cleanup_steps || []),
    ...(matrixCase.cleanup.failure_cleanup || []).map(step => `失败清理：${step}`),
    ...(matrixCase.cleanup.compensation || []).map(step => `补偿：${step}`),
  ];
  const traceTargets = unique([
    matrixCase.candidate_ref,
    matrixCase.source_scope.feature_ref,
    matrixCase.source_scope.scenario_ref,
    ...matrixCase.source_scope.acceptance_criteria,
  ]);
  return {
    case_id: matrixCase.case_id,
    goal: matrixCase.actor_goal.goal,
    preconditions: matrixCase.environment.setup?.length
      ? clone(matrixCase.environment.setup)
      : ['无额外前置条件'],
    actions: matrixCase.path.steps.map((action, index) => ({ step: index + 1, action })),
    oracles: [projectOracle(matrixCase.oracle)],
    cleanup,
    priority: matrixCase.value_risk.risk_level,
    trace_targets: traceTargets,
    path_class: matrixCase.path.path_class,
  };
}

export function composeArtifact(matrix, assessment, ctx = {}) {
  const cases = matrix.cases.map(matrixCase => projectCaseToArtifact(matrix, matrixCase, ctx));
  const candidates = assessment?.candidates || [];
  const matrixCandidateIds = new Set(matrix.cases.map(item => item.candidate_ref));
  const selectedCandidates = candidates.filter(item => matrixCandidateIds.has(item.candidate_id));
  const relations = [];
  for (const candidate of selectedCandidates) {
    if (candidate.scenario_ref) {
      relations.push({ kind: 'derives_from', target_type: 'scenario', target_id: stripQualifiedRef(candidate.scenario_ref) });
    }
    relations.push({
      kind: 'verifies',
      target_type: 'feature',
      target_id: stripQualifiedRef(candidate.feature_ref),
      anchor: candidate.ac_ref,
    });
  }
  for (const matrixCase of matrix.cases) {
    if (matrixCase.automation.implementation_binding) {
      relations.push({
        kind: 'implemented_by',
        target_type: 'code',
        target_id: matrixCase.automation.implementation_binding,
        anchor: matrixCase.case_id,
      });
    }
  }

  const actorNames = unique([
    ...(ctx.inspection?.business_context?.actors || []),
    ...matrix.cases.map(item => item.actor_goal.actor),
  ]);
  const components = unique([
    ...(ctx.inspection?.candidate_paths?.flatMap(item => item.boundaries || []) || []),
    ...matrix.cases.flatMap(item => item.path.cross_boundary || []),
  ]);
  const requiredArtifacts = unique(matrix.cases.flatMap(item => [
    item.automation.trace_report,
    ...(item.automation.required_artifacts || []),
  ]));
  const runners = unique(matrix.cases.map(item => item.automation.runner));

  return {
    metadata: {
      id: ctx.artifactId || `${matrix.matrix_id}:FILE`,
      title: ctx.title || `E2E 测试规格：${ctx.inspection?.business_context?.business_goal || matrix.matrix_id}`,
      status: ctx.status || 'active',
      test_batch: matrix.matrix_id,
    },
    scope: {
      business_goal: ctx.inspection?.business_context?.business_goal || matrix.cases[0].actor_goal.goal,
      actors: actorNames,
      system_boundaries: components,
      // WP1A：scope.non_goals 只能来自 inspection 的显式 non_goals；
      // business_context.constraints 是被测约束语义，绝不再投影为 non_goals。
      non_goals: clone(ctx.inspection?.business_context?.non_goals || []),
    },
    system_boundary: {
      components: components.length ? components : ['未声明系统边界'],
      external_dependencies: unique(matrix.cases.flatMap(item => item.environment.external_deps || [])),
      trust_boundaries: deriveTrustBoundaries(ctx.inspection),
    },
    coverage: {
      ac_coverage: Object.fromEntries(unique(matrix.cases.flatMap(item => item.source_scope.acceptance_criteria)).map(ac => [
        ac,
        matrix.cases.filter(item => item.source_scope.acceptance_criteria.includes(ac)).map(item => item.case_id),
      ])),
      related_scenarios: unique(matrix.cases.map(item => stripQualifiedRef(item.source_scope.scenario_ref))),
      related_features: unique(matrix.cases.map(item => stripQualifiedRef(item.source_scope.feature_ref || item.source_scope.source_artifact))),
      related_decisions: [],
    },
    environment_data: {
      topology: unique(matrix.cases.map(item => `${item.case_id}:${item.environment.topology}`)).join(' | '),
      fixtures: unique(matrix.cases.flatMap(item => [...item.data_identity.test_data, ...item.environment.setup])),
      identities: unique(matrix.cases.flatMap(item => item.data_identity.identities)),
      isolation_strategy: matrix.cases.map(item => `${item.case_id}:${item.data_identity.isolation}`).join(' | '),
    },
    relations,
    test_cases: cases,
    evidence_contract: {
      required_artifacts: requiredArtifacts.length ? requiredArtifacts : ['未声明证据产物'],
      runner_binding: runners.join(','),
      proof_requirements: unique(matrix.cases.map(item => `${item.case_id}:${item.automation.proof_condition}`)),
    },
  };
}

// WP1D：非确定性恢复写法的机械检测。每一种故障注入必须分别有确定性恢复动作，
// 不得用“若曾注入/注入过则恢复”这类以历史是否注入为条件的写法逃避逐故障绑定。
// 该模式可可靠机械识别，故失败关闭；命中即产生 E2E-F-007（清理/恢复不确定性）。
const NON_DETERMINISTIC_RECOVERY = /(若|如果|倘若|假如|要是)(曾注入|注入过)|曾注入[^，。；\n]{0,15}(则|就)|注入过[^，。；\n]{0,15}(则|就)/;

export function validateRecoveryDeterminism(matrix) {
  const findings = [];
  for (const matrixCase of matrix?.cases || []) {
    const cleanup = matrixCase.cleanup || {};
    const texts = [
      ...(cleanup.cleanup_steps || []),
      ...(cleanup.failure_cleanup || []),
      ...(cleanup.compensation || []),
      matrixCase.oracle?.observable,
      matrixCase.oracle?.criterion,
    ].filter(value => typeof value === 'string' && value.length);
    for (const text of texts) {
      const match = text.match(NON_DETERMINISTIC_RECOVERY);
      if (match) {
        findings.push({
          rule: 'E2E-F-007',
          severity: 'medium',
          repairability: 'safe-fix',
          case_ref: matrixCase.case_id,
          description: `恢复/清理动作必须确定性执行，逐故障注入分别绑定恢复动作、恢复健康检查与恢复后 oracle；不得以“若曾注入/注入过则”一类条件式写法逃避（命中：“${match[0]}”）`,
          evidence: text.slice(0, 120),
        });
        break;
      }
    }
  }
  return { valid: findings.length === 0, findings };
}

function compareValue(actual, expected) {
  return serializeMatrix(actual) === serializeMatrix(expected);
}

export function validateMatrixRoundTrip(matrix, artifact, companion = matrix) {
  const missing = [];
  const companionMatrix = companion?.matrix || companion;
  if (!compareValue(companionMatrix, matrix)) {
    missing.push({ caseId: '*', dimension: 'companion', field: 'matrix' });
  }
  const artifactCases = new Map((artifact?.test_cases || []).map(item => [item.case_id, item]));
  const matrixIds = matrix.cases.map(item => item.case_id);
  if (new Set(matrixIds).size !== matrixIds.length) {
    missing.push({ caseId: '*', dimension: 'identity', field: 'duplicate-matrix-case-id' });
  }
  for (const matrixCase of matrix.cases) {
    const projected = artifactCases.get(matrixCase.case_id);
    if (!projected) {
      missing.push({ caseId: matrixCase.case_id, dimension: 'identity', field: 'artifact-case' });
      continue;
    }
    const expected = projectCaseToArtifact(matrix, matrixCase);
    for (const field of ['goal', 'preconditions', 'actions', 'oracles', 'cleanup', 'priority', 'trace_targets', 'path_class']) {
      if (!compareValue(projected[field], expected[field])) {
        missing.push({ caseId: matrixCase.case_id, dimension: 'artifact-projection', field });
      }
    }
  }
  for (const caseId of artifactCases.keys()) {
    if (!matrixIds.includes(caseId)) missing.push({ caseId, dimension: 'identity', field: 'matrix-case' });
  }
  return { complete: missing.length === 0, missing };
}

export function bindArtifactToMatrix(artifact, matrix, ctx = {}) {
  const subjectBytes = ctx.artifactBytes || `${JSON.stringify(artifact, null, 2)}\n`;
  const matrixBytes = ctx.matrixBytes || `${JSON.stringify(matrix, null, 2)}\n`;
  const digestBytes = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const manifest = {
    schemaVersion: 1,
    packageId: ctx.packageId || `E2E-PKG-${matrix.matrix_id.replace(/^MATRIX-/, '')}`,
    familyApi: {
      id: 'artifact.e2e-test-family',
      major: ctx.familyApiMajor || 1,
      revisionDigest: ctx.familyApiRevisionDigest,
    },
    subject: {
      ref: ctx.artifactRef,
      artifactId: artifact.metadata.id,
      contract: 'artifact.e2e-test@1',
      contractRevisionDigest: ctx.contractRevisionDigest,
      mediaType: ctx.artifactMediaType || 'application/json',
      contentDigest: digestBytes(subjectBytes),
    },
    members: [{
      role: 'eight-dimensional-matrix',
      ref: ctx.matrixRef,
      memberId: matrix.matrix_id,
      protocol: 'e2e-test/matrix',
      version: '1',
      mediaType: 'application/json',
      contentDigest: digestBytes(matrixBytes),
    }],
    stageChainDigest: ctx.stageChainDigest,
  };
  manifest.packageDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex')}`;
  return manifest;
}

export function validateArtifactPackageManifest(manifest, { artifact, matrix, artifactBytes, matrixBytes } = {}) {
  const violations = [];
  const expected = bindArtifactToMatrix(artifact, matrix, {
    packageId: manifest.packageId,
    familyApiMajor: manifest.familyApi.major,
    familyApiRevisionDigest: manifest.familyApi.revisionDigest,
    contractRevisionDigest: manifest.subject.contractRevisionDigest,
    artifactRef: manifest.subject.ref,
    matrixRef: manifest.members.find(item => item.role === 'eight-dimensional-matrix')?.ref,
    artifactMediaType: manifest.subject.mediaType,
    stageChainDigest: manifest.stageChainDigest,
    artifactBytes,
    matrixBytes,
  });
  if (manifest.subject.contentDigest !== expected.subject.contentDigest) violations.push('subject-content-digest');
  const matrixMember = manifest.members.find(item => item.role === 'eight-dimensional-matrix');
  if (!matrixMember || matrixMember.contentDigest !== expected.members[0].contentDigest) violations.push('matrix-content-digest');
  if (manifest.packageDigest !== expected.packageDigest) violations.push('package-digest');
  const roundTrip = validateMatrixRoundTrip(matrix, artifact, matrix);
  if (!roundTrip.complete) violations.push('case-set-or-round-trip');
  return { valid: violations.length === 0, violations, roundTrip };
}
