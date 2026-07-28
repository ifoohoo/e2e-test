import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { runSync as inspectWorker } from '../../workers/inspect-worker.mjs';
import { runSync as assessWorker } from '../../workers/assess-worker.mjs';
import { runSync as designWorker } from '../../workers/design-worker.mjs';
import { runSync as composeWorker } from '../../workers/compose-worker.mjs';
import { runSync as reviewWorker } from '../../workers/review-core-worker.mjs';
import { runSync as repairWorker } from '../../workers/repair-core-worker.mjs';
import { runSync as reconcileWorker } from '../../workers/reconcile-worker.mjs';
import { runSync as validateWorker } from '../../workers/validate-worker.mjs';
import { stableDigest } from './digest.mjs';
import { matrixDigest } from './matrix-dto.mjs';
import {
  bytesDigest, commitPreview, computeStageChainDigest, createPreview, createRun,
  deriveRunId, loadRun, readIntermediate, readStageResult, updateRun, writeRawSnapshot,
} from './run-root.mjs';
import { validateSchema } from './schema-validation.mjs';
import { buildStageResult, persistStageResult } from './worker-runtime.mjs';

const STAGES = ['inspect', 'assess', 'design', 'compose', 'review-core', 'repair-core', 'reconcile', 'validate'];

export function handlesAuthorWorkflow(req) {
  return Boolean(req.rawInputs || req.inputs || req.runId || req.mode === 'commit' || req.commit);
}

export function dispatchAuthorWorkflow(req, projectRoot, pluginRoot) {
  try {
    if (req.mode === 'commit' || req.commit) return commitAuthor(req, projectRoot, pluginRoot);
    if (!req.runId) return req.inputs
      ? initializeResumeAuthor(req, projectRoot, pluginRoot)
      : initializeAuthor(req, projectRoot, pluginRoot);
    return advanceAuthor(req, projectRoot, pluginRoot);
  } catch (error) {
    const code = error.code || 'RUN_ROOT_INVALID';
    return blocked(code, req, error.field);
  }
}

function initializeResumeAuthor(req, projectRoot, pluginRoot) {
  if (!req.output) throw coded('OUTPUT_PATH_REQUIRED', 'output');
  const outputPaths = outputSet(req.output);
  const writeSet = [...new Set(req.writeSet || [])].sort();
  if (JSON.stringify(writeSet) !== JSON.stringify(Object.values(outputPaths).sort())) throw coded('WRITE_SET_VIOLATION', 'writeSet');
  const inputSpecs = [
    ['inspection', 'inspection.json'],
    ['assessment', 'candidate-assessment.json'],
    ['matrix', 'matrix.json'],
  ];
  const resolved = Object.fromEntries(inputSpecs.map(([key, schema]) => {
    const source = resolveSource(projectRoot, { kind: key, ref: req.inputs?.[key] });
    let value;
    try { value = JSON.parse(String(source.bytes)); } catch { throw coded('INPUT_SCHEMA_INVALID', `inputs.${key}`); }
    const validation = validateSchema(pluginRoot, schema, value);
    if (!validation.valid) throw coded('INPUT_SCHEMA_INVALID', `inputs.${key}`);
    return [key, { ...source, value }];
  }));
  if (resolved.assessment.value.inspection_ref !== resolved.inspection.value.inspection_id ||
      resolved.matrix.value.assessment_ref !== resolved.assessment.value.assessment_id) {
    throw coded('REFERENCE_MISMATCH', 'inputs');
  }
  const sources = inputSpecs.map(([key]) => ({ kind: key, ref: req.inputs[key], digest: bytesDigest(resolved[key].bytes) }));
  const resumeEnvelope = { goal: 'resume-author-from-validated-intermediates', sources };
  const runId = deriveRunId({ resumeEnvelope, projectRoot: realpathSync(projectRoot), output: req.output });
  const inputDigest = stableDigest(sources);
  const requestDigest = stableDigest({ inputs: req.inputs, inputDigest, output: req.output, writeSet });
  const { runRoot, manifest } = createRun({ runId, requestDigest, inputDigest, createdAt: req.stageTimestamp });
  if (!manifest.authorRequest) {
    manifest.sources = inputSpecs.map(([key]) => writeRawSnapshot(runRoot, { kind: key, ref: req.inputs[key] }, resolved[key].bytes));
    manifest.goal = resumeEnvelope.goal;
    manifest.context = { resume: true };
    manifest.authorRequest = { outputPaths, writeSet, bindings: baseBindings(req, pluginRoot, inputDigest, writeSet) };
    const common = { runId, runRoot, pluginRoot, projectRoot, stageTimestamp: req.stageTimestamp, writeSet };
    const inspectInput = { ...common, stage: 'inspect', inputs: { sourceRefs: [req.inputs.inspection] } };
    const inspectResult = buildStageResult({ stage: 'inspect', workerId: 'resume-import', input: inspectInput, outputs: resolved.inspection.value });
    persistStageResult(inspectInput, 'inspect', inspectResult, { 'inspection.json': resolved.inspection.value });
    const assessInput = { ...common, stage: 'assess', inputs: { prior: inspectResult, inspection: resolved.inspection.value } };
    const assessResult = buildStageResult({ stage: 'assess', workerId: 'resume-import', input: assessInput, outputs: resolved.assessment.value });
    persistStageResult(assessInput, 'assess', assessResult, { 'candidate-assessment.json': resolved.assessment.value });
    const designInput = { ...common, stage: 'design', inputs: { prior: assessResult, assessment: resolved.assessment.value } };
    const designResult = buildStageResult({ stage: 'design', workerId: 'resume-import', input: designInput, outputs: resolved.matrix.value });
    persistStageResult(designInput, 'design', designResult, { 'matrix.json': resolved.matrix.value });
    manifest.currentStage = 'compose';
    updateRun(runRoot, manifest);
  }
  return {
    status: 'PASS', code: 'AUTHOR_STAGE_READY', service: 'author', runId,
    stage: manifest.currentStage, nextAction: { skill: `stages/${manifest.currentStage}/SKILL.md`, stage: manifest.currentStage },
    diagnostics: [], stageResult: readStageResult(runRoot, 'design'), writeSet: [],
  };
}

function initializeAuthor(req, projectRoot, pluginRoot) {
  const raw = req.rawInputs;
  const validation = validateSchema(pluginRoot, 'author-raw-input.json', raw);
  if (!validation.valid || !raw?.goal?.trim() || !raw?.sources?.length) return needsInput('RAW_INPUT_REQUIRED', req, 'rawInputs', '需要非空 goal 与至少一个原始来源');
  if (!req.output) throw coded('OUTPUT_PATH_REQUIRED', 'output');
  const outputPaths = outputSet(req.output);
  if (JSON.stringify([...(req.writeSet || [])].sort()) !== JSON.stringify(Object.values(outputPaths).sort())) throw coded('WRITE_SET_VIOLATION', 'writeSet');
  const resolvedSources = raw.sources.map(source => resolveSource(projectRoot, source));
  const runId = deriveRunId({ raw, projectRoot: realpathSync(projectRoot), output: req.output });
  const inputDigest = stableDigest({ goal: raw.goal, sources: resolvedSources.map(({ bytes, ...item }) => ({ ...item, digest: bytesDigest(bytes) })), context: raw.context || {} });
  const requestDigest = stableDigest({ rawInputs: raw, output: req.output, writeSet: [...req.writeSet].sort() });
  const { runRoot, manifest } = createRun({ runId, requestDigest, inputDigest, createdAt: req.stageTimestamp });
  if (!manifest.sources) {
    manifest.sources = resolvedSources.map(item => writeRawSnapshot(runRoot, item.source, item.bytes));
    manifest.goal = raw.goal;
    manifest.context = raw.context || {};
    manifest.authorRequest = {
      outputPaths,
      writeSet: [...req.writeSet].sort(),
      bindings: baseBindings(req, pluginRoot, inputDigest, [...req.writeSet].sort()),
    };
    updateRun(runRoot, manifest);
  }
  return {
    status: 'PASS', code: 'AUTHOR_STAGE_READY', service: 'author', runId,
    stage: manifest.currentStage, nextAction: { skill: `stages/${manifest.currentStage}/SKILL.md`, stage: manifest.currentStage },
    diagnostics: [], stageResult: null, writeSet: [],
  };
}

function advanceAuthor(req, projectRoot, pluginRoot) {
  const { runRoot, manifest } = loadRun(req.runId);
  if (manifest.service !== 'author') throw coded('RUN_ROOT_INVALID');
  const stage = req.stage && req.stage !== 'auto' ? req.stage : manifest.currentStage;
  if (!STAGES.includes(stage) || stage !== manifest.currentStage) throw coded('STAGE_ORDER_VIOLATION', 'stage');
  const index = STAGES.indexOf(stage);
  const prior = index > 0 ? readStageResult(runRoot, STAGES[index - 1]) : null;
  const common = {
    stage, runId: req.runId, runRoot, pluginRoot, projectRoot,
    stageTimestamp: req.stageTimestamp, writeSet: manifest.authorRequest.writeSet,
  };
  let result;
  if (stage === 'inspect') {
    result = inspectWorker({ ...common, inputs: { sourceRefs: manifest.sources.map(item => item.ref) }, stageOutput: req.stageOutput });
  } else if (stage === 'assess') {
    result = assessWorker({ ...common, inputs: { prior, inspection: readIntermediate(runRoot, 'inspection.json') }, stageOutput: req.stageOutput });
  } else if (stage === 'design') {
    result = designWorker({ ...common, inputs: { prior, assessment: readIntermediate(runRoot, 'candidate-assessment.json') }, stageOutput: req.stageOutput });
  } else if (stage === 'compose') {
    const prefixDigest = computeStageChainDigest(runRoot, ['inspect', 'assess', 'design']);
    result = composeWorker({ ...common, inputs: {
      prior,
      inspection: readIntermediate(runRoot, 'inspection.json'),
      assessment: readIntermediate(runRoot, 'candidate-assessment.json'),
      matrix: readIntermediate(runRoot, 'matrix.json'),
      packageContext: {
        packageId: `E2E-PKG-${readIntermediate(runRoot, 'matrix.json').matrix_id.replace(/^MATRIX-/, '')}`,
        artifactRef: manifest.authorRequest.outputPaths.artifact,
        matrixRef: manifest.authorRequest.outputPaths.matrix,
        familyApiRevisionDigest: manifest.authorRequest.bindings.familyApiRevision,
        contractRevisionDigest: manifest.authorRequest.bindings.contractRevision,
        stageChainDigest: prefixDigest,
      },
    }, stageOutput: req.stageOutput });
  } else if (stage === 'review-core') {
    const artifact = readIntermediate(runRoot, 'artifact.json');
    const matrix = readIntermediate(runRoot, 'matrix.json');
    result = reviewWorker({ ...common, inputs: { prior, context: { artifact, matrix, companion: matrix } }, stageOutput: req.stageOutput });
  } else if (stage === 'repair-core') {
    const review = readIntermediate(runRoot, 'review-findings.json');
    result = repairWorker({ ...common, inputs: {
      prior,
      artifact: readIntermediate(runRoot, 'artifact.json'),
      matrix: readIntermediate(runRoot, 'matrix.json'),
      findings: review.findings, repairPlan: req.repairPlan || {},
    } });
    // M1-A req 4：实际发生修复（matrix 权威层已更新）后，必须重新
    // compose（重投影 artifact + 重绑 manifest）→ review-core → reconcile → validate，
    // 不得沿用修复前的评审与绑定结论。回卷次数封顶，防止修复声称与评审结论互相矛盾时死循环。
    if (result.status === 'PASS' && (result.outputs?.repairs || []).some(item => item.fixed)) {
      manifest.repairRewinds = (manifest.repairRewinds || 0) + 1;
      if (manifest.repairRewinds > 3) throw coded('REPAIR_TARGET_INVALID');
      result = { ...result, nextStage: 'compose' };
    }
  } else if (stage === 'reconcile') {
    const matrix = readIntermediate(runRoot, 'matrix.json');
    const manifestDto = readIntermediate(runRoot, 'artifact-package-manifest.json');
    const runnerInventory = resolveRunnerInventory(req.runnerInventory, projectRoot, manifest.runnerInventory);
    if (req.runnerInventory) manifest.runnerInventory = runnerInventory;
    const activeBindingCounts = Object.fromEntries(matrix.cases.map(item => [item.case_id, 1]));
    const proofContext = {
      bindingId: 'PROOF-001', timestamp: req.stageTimestamp || '1970-01-01T00:00:00.000Z',
      packageId: manifestDto.packageId, packageDigest: manifestDto.packageDigest,
      manifestRef: manifest.authorRequest.outputPaths.manifest,
      runnerInventory, activeBindingCounts,
    };
    result = reconcileWorker({ ...common, inputs: {
      prior, matrix, artifact: readIntermediate(runRoot, 'artifact.json'), proofContext,
    } });
    updateRun(runRoot, manifest);
  } else {
    const matrix = readIntermediate(runRoot, 'matrix.json');
    const artifact = readIntermediate(runRoot, 'artifact.json');
    const manifestDto = readIntermediate(runRoot, 'artifact-package-manifest.json');
    const activeBindingCounts = Object.fromEntries(matrix.cases.map(item => [item.case_id, 1]));
    result = validateWorker({ ...common, inputs: {
      prior, matrix, artifact, manifest: manifestDto,
      proofBinding: readIntermediate(runRoot, 'proof-binding.json'),
      proofContext: { runnerInventory: manifest.runnerInventory || {}, activeBindingCounts },
    } });
  }

  manifest.currentStage = result.nextStage;
  updateRun(runRoot, manifest);
  if (result.status === 'NEEDS_INPUT') return {
    status: 'NEEDS_INPUT', code: stage === 'repair-core' ? 'REPAIR_NEEDS_INPUT' : 'AUTHOR_NEEDS_INPUT', service: 'author',
    runId: req.runId, stage, diagnostics: result.needs_input || [], stageResult: result, writeSet: [],
  };
  if (result.status !== 'PASS') return blocked(result.status === 'FAIL' ? 'STAGE_SCHEMA_INVALID' : 'RUN_ROOT_INVALID', req);
  if (stage !== 'validate') return {
    status: 'PASS', code: 'AUTHOR_STAGE_READY', service: 'author', runId: req.runId,
    stage: result.nextStage, nextAction: { skill: `stages/${result.nextStage}/SKILL.md`, stage: result.nextStage },
    diagnostics: [], stageResult: result, writeSet: [],
  };
  return finalizePreview(req, projectRoot, runRoot, manifest, result);
}

function finalizePreview(req, projectRoot, runRoot, manifest, stageResult) {
  const artifact = readIntermediate(runRoot, 'artifact.json');
  const matrix = readIntermediate(runRoot, 'matrix.json');
  const packageManifest = readIntermediate(runRoot, 'artifact-package-manifest.json');
  // M1-A req 6：proof-binding 是正式交付物（第 4 件），随三件套一同预览/落盘，
  // 可由新进程独立复算（reconcileCases 对同一冻结输入是确定性的）。
  const proofBinding = readIntermediate(runRoot, 'proof-binding.json');
  const paths = manifest.authorRequest.outputPaths;
  const contentByPath = {
    [paths.artifact]: `${JSON.stringify(artifact, null, 2)}\n`,
    [paths.matrix]: `${JSON.stringify(matrix, null, 2)}\n`,
    [paths.manifest]: `${JSON.stringify(packageManifest, null, 2)}\n`,
    [paths.proof]: `${JSON.stringify(proofBinding, null, 2)}\n`,
  };
  const stageChainDigest = computeStageChainDigest(runRoot, STAGES);
  const previewResult = createPreview({
    runRoot, projectRoot, runId: manifest.runId, service: 'author',
    bindings: { ...manifest.authorRequest.bindings, matrixDigest: matrixDigest(matrix) },
    stageChainDigest, contentByPath, createdAt: req.stageTimestamp,
  });
  return {
    status: 'PASS', code: 'AUTHOR_PREVIEW_READY', service: 'author', runId: manifest.runId,
    diagnostics: [], stageResult, preview: previewResult.preview, commitSecret: previewResult.commitSecret,
    contractValidation: stageResult.outputs.contractValidation, writeSet: [],
  };
}

function commitAuthor(req, projectRoot, pluginRoot) {
  if (!req.commit) throw coded('COMMIT_HANDLE_INVALID', 'commit');
  const { manifest } = loadRun(req.commit.runId);
  const matrix = readIntermediate(loadRun(req.commit.runId).runRoot, 'matrix.json');
  const writeSet = [...new Set(req.writeSet || [])].sort();
  const base = baseBindings(req, pluginRoot, manifest.inputDigest, writeSet);
  const currentBindings = { ...base, matrixDigest: matrixDigest(matrix) };
  const committed = commitPreview({
    runId: req.commit.runId,
    request: { ...req.commit, writeSet, overwrite: req.overwrite, authorization: req.authorization },
    projectRoot, currentBindings,
  });
  const validationResult = readStageResult(loadRun(req.commit.runId).runRoot, 'validate');
  return {
    status: 'PASS', code: 'AUTHOR_COMPLETE', service: 'author', runId: req.commit.runId,
    diagnostics: [], stageResult: validationResult,
    artifactPath: manifest.authorRequest.outputPaths.artifact,
    artifactDigest: stableDigest(readIntermediate(loadRun(req.commit.runId).runRoot, 'artifact.json')),
    contractValidation: validationResult.outputs.contractValidation, writeSet: committed.committed, wrote: true,
  };
}

function baseBindings(req, pluginRoot, inputDigest, writeSet) {
  const api = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
  const implementation = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
  const bundleDigest = implementation.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  const contractRevision = req.projectFacts?.contractRevisionDigest || req._contractRevision;
  if (!bundleDigest || !contractRevision) throw coded('COMMIT_BINDING_DRIFT');
  return {
    inputDigest,
    providerDigest: stableDigest(providerIdentity(req._runLock)),
    familyApiRevision: api.api.revisionDigest,
    contractRevision,
    writeSetDigest: stableDigest([...writeSet].sort()),
    bundleDigest,
  };
}

function providerIdentity(runLock) {
  if (!runLock) return {};
  return runLock.provider || runLock.providerSelector || (runLock.bindingDigest ? { bindingDigest: runLock.bindingDigest } : {});
}

function resolveSource(projectRoot, source) {
  if (source.inline?.content) return { source, bytes: Buffer.from(source.inline.content) };
  if (isAbsolute(source.ref) || source.ref.startsWith('~') || source.ref.includes('\0')) throw coded('SOURCE_UNRESOLVABLE', source.ref);
  const root = realpathSync(projectRoot);
  const candidate = resolve(root, source.ref);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw coded('SOURCE_UNRESOLVABLE', source.ref);
  if (!existsSync(candidate)) throw coded('SOURCE_UNRESOLVABLE', source.ref);
  const real = realpathSync(candidate);
  const realRel = relative(root, real);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw coded('SOURCE_UNRESOLVABLE', source.ref);
  const bytes = readFileSync(real);
  if (source.digest && source.digest !== bytesDigest(bytes)) throw coded('SOURCE_UNRESOLVABLE', source.ref);
  return { source, bytes };
}

function resolveRunnerInventory(input, projectRoot, prior) {
  if (!input) return prior || {};
  if (typeof input === 'object') return structuredClone(input);
  const path = join(projectRoot, input);
  if (!existsSync(path)) throw coded('SOURCE_UNRESOLVABLE', 'runnerInventory');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function outputSet(output) {
  const info = parse(output);
  const extension = extname(output) || '.json';
  const base = join(info.dir, info.name);
  return {
    artifact: output,
    matrix: `${base}.matrix${extension}`,
    manifest: `${base}.package${extension}`,
    // M1-A req 6：proof-binding 为第 4 件正式交付物。
    proof: `${base}.proof${extension}`,
  };
}

function blocked(code, req, field) {
  return { status: 'BLOCKED', code, service: 'author', diagnostics: [{ code, severity: 'error', ...(field ? { field } : {}) }], stageResult: null, contractValidation: null, writeSet: [] };
}

function needsInput(code, req, field, reason) {
  return { status: 'NEEDS_INPUT', code, service: 'author', diagnostics: [{ code, severity: 'warning', field, reason }], stageResult: null, contractValidation: null, writeSet: [] };
}

function coded(code, field) {
  return Object.assign(new Error(code), { code, field });
}
