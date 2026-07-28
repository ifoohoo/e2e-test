export const STAGE_ORDER = Object.freeze([
  'inspect', 'assess', 'design', 'compose',
  'review-core', 'repair-core', 'reconcile', 'validate',
]);

export const NEXT_STAGE = Object.freeze(Object.fromEntries(STAGE_ORDER.map((stage, index) => [stage, STAGE_ORDER[index + 1] || 'none'])));

export function expectedPriorStage(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  return index > 0 ? STAGE_ORDER[index - 1] : null;
}

export function nextStageFor(stage, status) {
  if (status === 'PASS') return NEXT_STAGE[stage];
  if (status === 'NEEDS_INPUT') return stage;
  return 'none';
}
