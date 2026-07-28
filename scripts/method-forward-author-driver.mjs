#!/usr/bin/env node

/**
 * 方法正向试验的确定性 author 驱动器。
 *
 * 宿主负责读取未知原始输入和公开方法，生成前三个模型工序的输出；本驱动器
 * 只负责把它们送入真实八工序运行时、完成确定性工序并生成默认预览。它从不
 * 执行 commit，也不接受宿主自报的阶段摘要。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { dispatch } from './service-dispatch.mjs';
import { containsAbsolutePath } from './lib/behavior-qualification.mjs';
import { stableDigest } from './lib/digest.mjs';
import { validateSchema } from './lib/schema-validation.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const projectRoot = value('--project-root');
const stageInputsPath = value('--stage-inputs');
const outputPath = value('--output');
const packageId = value('--package');
const hostId = value('--host');

try {
  if (![projectRoot, stageInputsPath, outputPath].every(item => item && isAbsolute(item)) ||
      !/^fwd-[a-z0-9-]+$/.test(packageId || '') || !['codex', 'claude-code'].includes(hostId)) {
    throw coded('FORWARD_DRIVER_ARGUMENT_INVALID');
  }
  const canonicalProject = resolve(projectRoot);
  if (!existsSync(canonicalProject) || !resolve(stageInputsPath).startsWith(`${canonicalProject}/`) ||
      !resolve(outputPath).startsWith(`${canonicalProject}/`)) throw coded('FORWARD_DRIVER_PATH_INVALID');
  const stageInputs = JSON.parse(readFileSync(stageInputsPath, 'utf8'));
  if (containsAbsolutePath(stageInputs)) throw coded('FORWARD_STAGE_OUTPUT_PATH_LEAK');
  for (const name of ['inspection', 'assessment', 'matrix']) if (!stageInputs[name]) throw coded('FORWARD_STAGE_OUTPUT_MISSING');
  validateStageInputs(stageInputs);

  const rawFiles = ['feature.json', 'scenario.md', 'project-facts.json', 'goal.md'];
  for (const name of rawFiles) if (!existsSync(join(canonicalProject, 'raw', name))) throw coded('FORWARD_RAW_INPUT_MISSING');
  const goal = readFileSync(join(canonicalProject, 'raw', 'goal.md'), 'utf8').trim();
  const facts = JSON.parse(readFileSync(join(canonicalProject, 'raw', 'project-facts.json'), 'utf8'));
  const contractRevisionDigest = explainContract();
  const output = `artifacts/e2e/${packageId}.json`;
  const writeSet = [output, output.replace(/\.json$/, '.matrix.json'), output.replace(/\.json$/, '.package.json'), output.replace(/\.json$/, '.proof.json')];
  const context = {
    projectFacts: { contractRevisionDigest },
    _runLock: { provider: { pluginId: 'e2e-test', hostId, mode: 'method-forward-trial' } },
    stageTimestamp: '1970-01-01T00:00:00.000Z',
  };
  let response = dispatch({
    service: 'author', output, writeSet,
    rawInputs: {
      schemaVersion: 1,
      goal,
      sources: [
        { kind: 'prd-feature', ref: 'raw/feature.json' },
        { kind: 'scenario-script', ref: 'raw/scenario.md' },
        { kind: 'project-fact', ref: 'raw/project-facts.json' },
      ],
    },
    ...context,
  }, canonicalProject);
  if (response.code !== 'AUTHOR_STAGE_READY' || response.stage !== 'inspect') throw executionFailure('initialize', response);
  const runId = response.runId;
  const modelStages = [
    ['inspect', stageInputs.inspection],
    ['assess', stageInputs.assessment],
    ['design', stageInputs.matrix],
  ];
  for (const [stage, stageOutput] of modelStages) {
    response = dispatch({ service: 'author', runId, stage, stageOutput, ...context }, canonicalProject);
    if (response.code !== 'AUTHOR_STAGE_READY') throw executionFailure(stage, response);
  }
  for (const stage of ['compose', 'review-core', 'repair-core', 'reconcile', 'validate']) {
    const request = { service: 'author', runId, stage, ...context };
    if (stage === 'reconcile') request.runnerInventory = facts.runnerInventory || {};
    response = dispatch(request, canonicalProject);
    const expected = stage === 'validate' ? 'AUTHOR_PREVIEW_READY' : 'AUTHOR_STAGE_READY';
    if (response.code !== expected) throw executionFailure(stage, response);
  }
  const sanitized = structuredClone(response);
  delete sanitized.commitSecret;
  const result = {
    schemaVersion: 1,
    status: 'AUTHOR_PREVIEW_READY',
    packageId,
    hostId,
    runId,
    stageInputsDigest: stableDigest(stageInputs),
    preview: sanitized.preview,
    contractValidation: sanitized.contractValidation,
  };
  result.digest = stableDigest(result);
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, packageId, hostId, result: 'results/author-output.json', digest: result.digest })}\n`);
} catch (error) {
  const blocked = { status: 'BLOCKED', code: codeOf(error) };
  if (Array.isArray(error?.diagnostics) && error.diagnostics.length) blocked.diagnostics = error.diagnostics;
  process.stdout.write(`${JSON.stringify(blocked)}\n`);
  process.exitCode = 1;
}

function validateStageInputs(stageInputs) {
  const specs = [
    ['inspection', 'inspection.json'],
    ['assessment', 'candidate-assessment.json'],
    ['matrix', 'matrix.json'],
  ];
  const diagnostics = [];
  for (const [stage, schema] of specs) {
    const result = validateSchema(pluginRoot, schema, stageInputs[stage]);
    for (const error of result.errors || []) diagnostics.push({
      stage,
      instancePath: error.instancePath || '/',
      keyword: error.keyword || 'schema',
      message: String(error.message || '不符合 schema').slice(0, 240),
    });
  }
  const inspectionRef = stageInputs.assessment?.inspection_ref;
  if (inspectionRef !== stageInputs.inspection?.inspection_id) diagnostics.push({
    stage: 'assessment', instancePath: '/inspection_ref', keyword: 'reference', message: '必须引用 inspection.inspection_id',
  });
  const assessmentRef = stageInputs.matrix?.assessment_ref;
  if (assessmentRef !== stageInputs.assessment?.assessment_id) diagnostics.push({
    stage: 'matrix', instancePath: '/assessment_ref', keyword: 'reference', message: '必须引用 assessment.assessment_id',
  });
  const observed = new Set(stageInputs.inspection?.inputs?.source_ids || []);
  for (const ref of ['raw/feature.json', 'raw/scenario.md', 'raw/project-facts.json']) {
    if (!observed.has(ref)) diagnostics.push({
      stage: 'inspection', instancePath: '/inputs/source_ids', keyword: 'source-coverage', message: `必须包含 ${ref}`,
    });
  }
  if (diagnostics.length) throw Object.assign(coded('FORWARD_STAGE_INPUT_INVALID'), { diagnostics });
}

function executionFailure(stage, response) {
  const diagnostics = [{
    stage,
    upstreamStatus: String(response?.status || 'UNKNOWN').slice(0, 80),
    upstreamCode: String(response?.code || 'UNKNOWN').slice(0, 120),
  }];
  for (const item of response?.diagnostics || []) diagnostics.push({
    stage,
    upstreamCode: String(item?.code || response?.code || 'UNKNOWN').slice(0, 120),
    ...(item?.field ? { field: String(item.field).slice(0, 160) } : {}),
  });
  return Object.assign(coded('FORWARD_STAGE_EXECUTION_FAILED'), { diagnostics });
}

function explainContract() {
  const command = process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND;
  if (!command || !isAbsolute(command) || !existsSync(command)) throw coded('ARTIFACT_CONTRACT_UNAVAILABLE');
  try {
    const output = execFileSync(process.execPath, [command, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output);
    const digest = parsed?.data?.identity?.revisionDigest;
    if (parsed?.ok === true && /^sha256:[a-f0-9]{64}$/.test(digest)) return digest;
  } catch {}
  throw coded('ARTIFACT_CONTRACT_UNAVAILABLE');
}

function coded(code) { return Object.assign(new Error(code), { code }); }
function codeOf(error) { return String(error?.code || error?.message || 'FORWARD_DRIVER_FAILED').match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'FORWARD_DRIVER_FAILED'; }
