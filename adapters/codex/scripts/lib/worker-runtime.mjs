import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { stableDigest } from './digest.mjs';
import { expectedPriorStage, nextStageFor } from './stage-pipeline.mjs';
import { validateSchema } from './schema-validation.mjs';

export const DEFAULT_STAGE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function contained(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertWorkerInput(input, stage) {
  if (input.stage !== stage) throw Object.assign(new Error(`expected ${stage}, got ${input.stage}`), { code: 'STAGE_ORDER_VIOLATION' });
  if (!/^run-[0-9a-f]{16,64}$/.test(input.runId || '')) throw Object.assign(new Error('invalid runId'), { code: 'RUN_ROOT_INVALID' });
  if (!input.runRoot || !input.pluginRoot) throw Object.assign(new Error('runRoot/pluginRoot required'), { code: 'RUN_ROOT_INVALID' });
  if (input.projectRoot && contained(input.projectRoot, input.runRoot)) throw Object.assign(new Error('run root must be outside project root'), { code: 'RUN_ROOT_INVALID' });
  const priorStage = expectedPriorStage(stage);
  if (priorStage) {
    const prior = input.inputs?.prior;
    const valid = prior && prior.stage === priorStage && prior.status === 'PASS' && prior.nextStage === stage
      && prior.inputDigest === stableDigest(prior.inputs || {}) && prior.outputDigest === stableDigest(prior.outputs || {});
    if (!valid) throw Object.assign(new Error('prior stage digest mismatch'), { code: 'STAGE_PRIOR_DIGEST_MISMATCH' });
  }
}

export function buildStageResult({ stage, workerId, input, status = 'PASS', outputs = {}, findings = [], needsInput = [] }) {
  const inputs = structuredClone(input.inputs || {});
  // 工序间只持有上一结果的内容寻址引用。把完整 result 递归嵌入下一结果会令
  // 八工序响应持续膨胀，并最终超过宿主进程的结构化输出缓冲区。
  if (inputs.prior) inputs.prior = stageResultReference(inputs.prior);
  const result = {
    stage,
    status,
    timestamp: input.stageTimestamp || DEFAULT_STAGE_TIMESTAMP,
    runId: input.runId,
    inputDigest: stableDigest(inputs),
    outputDigest: stableDigest(outputs),
    inputs,
    outputs,
    writeSet: [...new Set(input.writeSet || [])],
    nextStage: nextStageFor(stage, status),
    workerId,
  };
  if (findings.length) result.findings = findings.map(item => ({
    ...item,
    description: item.description || item.evidence || `${item.rule} detected`,
  }));
  if (needsInput.length) result.needs_input = needsInput;
  return result;
}

export function stageResultReference(result) {
  return {
    stage: result.stage,
    status: result.status,
    nextStage: result.nextStage,
    inputDigest: result.inputDigest,
    outputDigest: result.outputDigest,
    resultDigest: stableDigest(result),
  };
}

export function persistStageResult(input, stage, result, intermediateFiles = {}) {
  const stagePath = join(input.runRoot, 'stage-results', `${stage}.json`);
  if (!contained(input.runRoot, stagePath)) throw Object.assign(new Error('stage result escapes run root'), { code: 'STAGE_WRITE_SET_ESCAPE' });
  atomicJson(stagePath, result);
  for (const [file, value] of Object.entries(intermediateFiles)) {
    const target = join(input.runRoot, 'intermediates', file);
    if (!contained(input.runRoot, target)) throw Object.assign(new Error('intermediate escapes run root'), { code: 'STAGE_WRITE_SET_ESCAPE' });
    atomicJson(target, value);
  }
}

export function finalizeWorkerResult(input, stage, workerId, payload) {
  const result = buildStageResult({ stage, workerId, input, ...payload });
  const validation = validateSchema(input.pluginRoot, 'stage-result.json', result);
  if (!validation.valid) {
    const error = new Error(`stage result schema invalid: ${JSON.stringify(validation.errors)}`);
    error.code = 'STAGE_SCHEMA_INVALID';
    throw error;
  }
  persistStageResult(input, stage, result, payload.intermediateFiles || {});
  return result;
}

function atomicJson(target, value) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
