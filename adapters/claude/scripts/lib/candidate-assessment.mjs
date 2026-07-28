// WP1C：候选选择质量的机械校验。
// schema（schemas/candidate-assessment.json）保证 e2e_rationale 的结构存在；
// 本模块进一步失败关闭「标签式理由」与「重复 path_summary」这类形式上存在、
// 实质上未论证“为什么下层测试不足”的候选，避免较窄协同路径被包装为 E2E。
// 只做通用结构/文本判定，不写死任何业务 fixture 的答案。

const LABEL_ONLY = new Set(['c1', 'c2', 'c3', 'c4', 'c1/c2', 'c3/c4', 'c1/c2/c3/c4']);

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLabelOnly(text) {
  const norm = normalize(text);
  if (LABEL_ONLY.has(norm)) return true;
  // 仅由准则标签与分隔符组成（如 "C3、C4" / "C3/C4"）也视为标签式。
  return norm.length > 0 && /^[\s,，、/|+c1234]*$/.test(norm) && /c[1-4]/.test(norm);
}

/**
 * 校验单个 E2E 候选的 e2e_rationale 是否充分。
 * @returns {{ valid: boolean, diagnostics: string[] }}
 */
export function validateCandidateRationale(candidate) {
  const diagnostics = [];
  const id = candidate?.candidate_id ?? 'CAND-?';
  const pathSummary = normalize(candidate?.path_summary);
  const rationale = candidate?.e2e_rationale;
  if (!rationale || typeof rationale !== 'object') {
    return { valid: false, diagnostics: [`${id}:CANDIDATE_RATIONALE_MISSING`] };
  }
  const meanings = Array.isArray(rationale.criteria_meanings) ? rationale.criteria_meanings : [];
  if (meanings.length === 0) diagnostics.push(`${id}:CANDIDATE_RATIONALE_MISSING`);

  // 覆盖性：criteria_met 中每个准则都必须有对应的含义说明。
  const covered = new Set(meanings.map(item => item?.criterion));
  for (const criterion of candidate?.criteria_met || []) {
    if (!covered.has(criterion)) diagnostics.push(`${id}:CRITERION_MEANING_MISSING:${criterion}`);
  }

  for (const item of meanings) {
    const meaning = item?.meaning;
    if (isLabelOnly(meaning)) {
      diagnostics.push(`${id}:CRITERION_MEANING_LABEL_ONLY:${item?.criterion ?? '?'}`);
      continue;
    }
    if (normalize(meaning) && normalize(meaning) === pathSummary) {
      diagnostics.push(`${id}:CRITERION_MEANING_REPEATS_PATH_SUMMARY:${item?.criterion ?? '?'}`);
    }
  }

  const risk = rationale.collaboration_risk;
  if (isLabelOnly(risk) || (normalize(risk) && normalize(risk) === pathSummary)) {
    diagnostics.push(`${id}:COLLABORATION_RISK_INSUFFICIENT`);
  }

  const insufficiency = rationale.lower_tier_insufficiency;
  if (
    isLabelOnly(insufficiency) ||
    (normalize(insufficiency) && normalize(insufficiency) === pathSummary) ||
    (normalize(insufficiency) && normalize(insufficiency) === normalize(risk))
  ) {
    diagnostics.push(`${id}:LOWER_TIER_INSUFFICIENCY_INSUFFICIENT`);
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/**
 * 校验整份 candidate assessment：仅对 decision=E2E 的候选强制充分理由；
 * 下沉项（DOWNSTREAM）保留，不要求 e2e_rationale。
 * @returns {{ valid: boolean, diagnostics: string[] }}
 */
export function validateAssessmentRationale(assessment) {
  const diagnostics = [];
  for (const candidate of assessment?.candidates || []) {
    const result = validateCandidateRationale(candidate);
    if (!result.valid) diagnostics.push(...result.diagnostics);
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
