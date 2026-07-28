import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { stableDigest } from './digest.mjs';

export function deriveRunId(rawInputs) {
  return `run-${stableDigest(rawInputs).slice(7, 23)}`;
}

export function resolveRunsRoot() {
  return resolve(process.env.E2E_TEST_RUN_ROOT || join(tmpdir(), 'e2e-test-runs'));
}

export function resolveRunRoot(runId) {
  if (!/^run-[0-9a-f]{16,64}$/.test(runId || '')) throw coded('RUN_ROOT_INVALID');
  const runsRoot = resolveRunsRoot();
  const runRoot = resolve(runsRoot, runId);
  if (!contained(runsRoot, runRoot)) throw coded('RUN_ROOT_INVALID');
  return runRoot;
}

export function createRun({ runId, service = 'author', requestDigest, inputDigest, createdAt }) {
  const runRoot = resolveRunRoot(runId);
  mkdirSync(join(runRoot, 'raw-inputs'), { recursive: true });
  mkdirSync(join(runRoot, 'stage-results'), { recursive: true });
  mkdirSync(join(runRoot, 'intermediates'), { recursive: true });
  mkdirSync(join(runRoot, 'outputs'), { recursive: true });
  const manifestPath = join(runRoot, 'run-manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (existing.requestDigest !== requestDigest || existing.inputDigest !== inputDigest) throw coded('RUN_ROOT_INVALID');
    return { runRoot, manifest: existing };
  }
  const manifest = { runId, service, requestDigest, inputDigest, currentStage: 'inspect', createdAt: createdAt || '1970-01-01T00:00:00.000Z' };
  atomicJson(manifestPath, manifest);
  return { runRoot, manifest };
}

export function loadRun(runId) {
  const runRoot = resolveRunRoot(runId);
  const path = join(runRoot, 'run-manifest.json');
  if (!existsSync(path)) throw coded('RUN_ROOT_INVALID');
  return { runRoot, manifest: JSON.parse(readFileSync(path, 'utf8')) };
}

export function updateRun(runRoot, manifest) {
  atomicJson(join(runRoot, 'run-manifest.json'), manifest);
}

export function writeRawSnapshot(runRoot, source, bytes) {
  const digest = bytesDigest(bytes);
  const path = join(runRoot, 'raw-inputs', `${digest.slice(7, 23)}.json`);
  const snapshot = { kind: source.kind, ref: source.ref, digest, content: String(bytes) };
  atomicJson(path, snapshot);
  return { ref: source.ref, kind: source.kind, digest, snapshot: relative(runRoot, path) };
}

export function readIntermediate(runRoot, name) {
  const path = join(runRoot, 'intermediates', name);
  if (!existsSync(path)) throw coded('RUN_ROOT_INVALID');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeIntermediate(runRoot, name, value) {
  const dir = join(runRoot, 'intermediates');
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, name), value);
}

export function readStageResult(runRoot, stage) {
  const path = join(runRoot, 'stage-results', `${stage}.json`);
  if (!existsSync(path)) throw coded('RUN_ROOT_INVALID');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function computeStageChainDigest(runRoot, stages) {
  const results = stages.map(stage => readStageResult(runRoot, stage));
  for (let index = 1; index < results.length; index += 1) {
    const prior = results[index].inputs?.prior;
    const expected = results[index - 1];
    if (!prior || prior.stage !== expected.stage || prior.status !== expected.status
      || prior.nextStage !== results[index].stage || prior.inputDigest !== expected.inputDigest
      || prior.outputDigest !== expected.outputDigest || prior.resultDigest !== stableDigest(expected)) {
      throw coded('STAGE_PRIOR_DIGEST_MISMATCH');
    }
  }
  return stableDigest(results.map(item => {
    return { stage: item.stage, status: item.status, inputDigest: item.inputDigest, outputDigest: item.outputDigest };
  }));
}

export function createPreview({ runRoot, projectRoot, runId, service, bindings, stageChainDigest, contentByPath, createdAt }) {
  const paths = Object.keys(contentByPath).sort();
  const plannedWrites = paths.map(path => {
    const bytes = Buffer.from(contentByPath[path]);
    const target = safeProjectPath(projectRoot, path);
    return {
      path,
      contentDigest: bytesDigest(bytes),
      bytes: bytes.byteLength,
      targetExists: existsSync(target),
      diffSummary: existsSync(target) ? (bytesDigest(readFileSync(target)) === bytesDigest(bytes) ? 'unchanged' : 'modified') : 'created',
    };
  });
  const completeBindings = { ...bindings, writeSetDigest: stableDigest(paths) };
  const handleId = `handle-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  const commitHandle = { handleId, secretDigest: bytesDigest(secret), oneTime: true };
  const previewCore = { service, runId, bindings: completeBindings, plannedWrites, stageChainDigest };
  const preview = {
    schemaVersion: 1, kind: 'preview', service, runId, status: 'PREVIEW_READY',
    bindings: completeBindings, plannedWrites, stageChainDigest,
    previewDigest: stableDigest(previewCore), commitHandle,
    createdAt: createdAt || '1970-01-01T00:00:00.000Z',
  };
  for (const [path, content] of Object.entries(contentByPath)) atomicBytes(join(runRoot, 'outputs', path), content);
  atomicJson(join(runRoot, 'preview-manifest.json'), preview);
  const secretPath = join(runRoot, 'commit-secret');
  atomicBytes(secretPath, secret);
  try { chmodSync(secretPath, 0o600); } catch {}
  return { preview, commitSecret: secret };
}

export function commitPreview({ runId, request, projectRoot, currentBindings }) {
  const { runRoot } = loadRun(runId);
  const previewPath = join(runRoot, 'preview-manifest.json');
  const lockPath = join(runRoot, 'commit.lock');
  if (!existsSync(previewPath)) throw coded('RUN_ROOT_INVALID');
  const preview = JSON.parse(readFileSync(previewPath, 'utf8'));
  if (existsSync(lockPath) || ['COMMITTED', 'CONSUMED'].includes(preview.status)) throw coded('COMMIT_REPLAYED');
  if (preview.status !== 'PREVIEW_READY') throw coded('COMMIT_BINDING_DRIFT');
  if (request.runId !== preview.runId || request.handleId !== preview.commitHandle.handleId) throw coded('COMMIT_HANDLE_INVALID');
  const secretPath = join(runRoot, 'commit-secret');
  const secret = request.secret ?? (existsSync(secretPath) ? readFileSync(secretPath, 'utf8') : '');
  if (bytesDigest(secret) !== preview.commitHandle.secretDigest) throw coded('COMMIT_SECRET_MISMATCH');
  if (stableDigest(currentBindings) !== stableDigest(preview.bindings)) throw coded('COMMIT_BINDING_DRIFT');
  const core = { service: preview.service, runId: preview.runId, bindings: preview.bindings, plannedWrites: preview.plannedWrites, stageChainDigest: preview.stageChainDigest };
  if (stableDigest(core) !== preview.previewDigest) throw coded('COMMIT_BINDING_DRIFT');
  const requested = [...new Set(request.writeSet || [])].sort();
  const planned = preview.plannedWrites.map(item => item.path).sort();
  if (JSON.stringify(requested) !== JSON.stringify(planned)) throw coded('WRITE_SET_VIOLATION');
  if (request.authorization?.granted !== true) throw coded('AUTHORIZATION_DENIED');
  for (const item of preview.plannedWrites) if (item.targetExists && !request.overwrite) throw coded('OUTPUT_EXISTS_NO_OVERWRITE');

  const journalPath = join(runRoot, 'commit.journal');
  const backups = [];
  atomicJson(journalPath, { phase: 'prepared', writes: preview.plannedWrites.map(({ path, contentDigest }) => ({ path, contentDigest })) });
  try {
    for (const item of preview.plannedWrites) {
      const source = join(runRoot, 'outputs', item.path);
      if (!existsSync(source) || bytesDigest(readFileSync(source)) !== item.contentDigest) throw coded('COMMIT_BINDING_DRIFT');
      const target = safeProjectPath(projectRoot, item.path);
      backups.push({ target, existed: existsSync(target), bytes: existsSync(target) ? readFileSync(target) : null });
      mkdirSync(dirname(target), { recursive: true });
      atomicJson(journalPath, { phase: 'writing', writes: preview.plannedWrites.map(({ path, contentDigest }) => ({ path, contentDigest })) });
      atomicBytes(target, readFileSync(source));
    }
    for (const item of preview.plannedWrites) if (bytesDigest(readFileSync(safeProjectPath(projectRoot, item.path))) !== item.contentDigest) throw coded('COMMIT_BINDING_DRIFT');
    atomicJson(journalPath, { phase: 'done', writes: preview.plannedWrites.map(({ path, contentDigest }) => ({ path, contentDigest })) });
    preview.status = 'COMMITTED';
    atomicJson(previewPath, preview);
    atomicJson(lockPath, { runId, previewDigest: preview.previewDigest, status: 'CONSUMED' });
    if (existsSync(secretPath)) unlinkSync(secretPath);
    return { preview, committed: planned };
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (backup.existed) atomicBytes(backup.target, backup.bytes);
      else rmSync(backup.target, { force: true });
    }
    throw error;
  }
}

export function bytesDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeProjectPath(projectRoot, relPath) {
  if (!relPath || isAbsolute(relPath) || relPath.startsWith('~') || relPath.includes('\0')) throw coded('STAGE_WRITE_SET_ESCAPE');
  const root = realpathSync(projectRoot);
  const target = resolve(root, relPath);
  if (!contained(root, target)) throw coded('STAGE_WRITE_SET_ESCAPE');
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (!contained(root, realAncestor)) throw coded('STAGE_WRITE_SET_ESCAPE');
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw coded('STAGE_WRITE_SET_ESCAPE');
  return target;
}

function contained(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function atomicJson(path, value) {
  atomicBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}
