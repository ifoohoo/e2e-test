#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const projectRoot = value('--project-root');
const serviceRunner = value('--service-runner');
const artifactGraphCommand = value('--artifact-graph-command');

if (![projectRoot, serviceRunner, artifactGraphCommand].every(item => item && isAbsolute(item))) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: 'QUALIFICATION_ARGUMENT_INVALID' }));
  process.exit(1);
}

const canonicalProjectRoot = resolve(projectRoot);
const withinProject = relativePath => {
  const target = resolve(canonicalProjectRoot, relativePath);
  if (target !== canonicalProjectRoot && !target.startsWith(`${canonicalProjectRoot}/`)) {
    throw new Error('QUALIFICATION_PATH_ESCAPE');
  }
  return target;
};

const trials = [
  ['help', 0], ['author-no-binding', 1], ['review-no-binding', 1], ['repair-no-binding', 1],
  ['author', 0], ['review', 0], ['repair', 0], ['re-review', 0],
  ['business-review', 0], ['business-decision', 0],
  ['bundle-drift', 1], ['host-swap', 1], ['caller-lock', 1], ['default-write-reject', 1],
];

for (const [id, expectedExit] of trials) {
  if (id === 'author') {
    runAuthorTrial();
    continue;
  }
  if (id === 'repair') {
    runRepairTrial();
    continue;
  }
  runStaticTrial(id, expectedExit);
}

function runStaticTrial(id, expectedExit) {
  const request = JSON.parse(readFileSync(withinProject(`requests/${id}.json`), 'utf8'));
  const result = executeRequest(request);
  const output = withinProject(`qualification-results/trials/${id}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.stdout ?? '');
  if (result.error || result.signal || result.status !== expectedExit) blockedTrial(id);
}

function runAuthorTrial() {
  const base = JSON.parse(readFileSync(withinProject('requests/author.json'), 'utf8'));
  const initial = executeRequest(base);
  const initialized = parseResult(initial, 'author-initialize');
  if (initial.status !== 0 || initialized.code !== 'AUTHOR_STAGE_READY' || initialized.stage !== 'compose') blockedTrial('author-initialize');
  let current = initialized;
  for (const stage of ['compose', 'review-core', 'repair-core', 'reconcile', 'validate']) {
    const request = { ...base, runId: initialized.runId, stage };
    delete request.inputs;
    delete request.output;
    delete request.writeSet;
    if (stage === 'reconcile') request.runnerInventory = { playwright: { active: true } };
    const result = executeRequest(request);
    current = parseResult(result, `author-${stage}`);
    const expected = stage === 'validate' ? 'AUTHOR_PREVIEW_READY' : 'AUTHOR_STAGE_READY';
    if (result.status !== 0 || current.code !== expected) blockedTrial(`author-${stage}`);
  }
  const commit = { ...base, mode: 'commit', commit: { runId: initialized.runId, handleId: current.preview?.commitHandle?.handleId } };
  delete commit.inputs;
  delete commit.output;
  const final = executeRequest(commit);
  if (final.status !== 0 || parseResult(final, 'author').code !== 'AUTHOR_COMPLETE') blockedTrial('author');
  persistResult('author', final.stdout);
}

function runRepairTrial() {
  const base = JSON.parse(readFileSync(withinProject('requests/repair.json'), 'utf8'));
  const previewResult = executeRequest(base);
  const preview = parseResult(previewResult, 'repair-preview');
  if (previewResult.status !== 0 || preview.code !== 'REPAIR_PREVIEW_READY') blockedTrial('repair-preview');
  const commit = { ...base, mode: 'commit', commit: { runId: preview.runId, handleId: preview.preview?.commitHandle?.handleId } };
  delete commit.inputArtifact;
  delete commit.inputMatrix;
  delete commit.inputPackageManifest;
  delete commit.reviewResult;
  delete commit.output;
  delete commit.outputMatrix;
  delete commit.outputManifest;
  delete commit.repairPlan;
  const final = executeRequest(commit);
  if (final.status !== 0 || parseResult(final, 'repair').code !== 'REPAIR_COMPLETE') blockedTrial('repair');
  persistResult('repair', final.stdout);
}

function executeRequest(request) {
  const scratch = mkdtempSync(join(tmpdir(), 'e2e-qualification-request-'));
  const requestPath = join(scratch, 'request.json');
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const result = spawnSync(process.execPath, [serviceRunner, '--request', requestPath, '--json'], {
    cwd: canonicalProjectRoot,
    env: { ...process.env, E2E_TEST_ARTIFACT_GRAPH_COMMAND: artifactGraphCommand },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

function parseResult(result, id) {
  try { return JSON.parse(result.stdout || '{}'); }
  catch { blockedTrial(id); }
}

function persistResult(id, stdout) {
  const output = withinProject(`qualification-results/trials/${id}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, stdout || '');
}

function blockedTrial(id) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: 'QUALIFICATION_TRIAL_FAILED', trial: id }));
  process.exit(1);
}

writeFileSync(withinProject('qualification-control/business-command.ok'), 'BUSINESS_COMMAND_COMPLETE\n');
console.log(JSON.stringify({ status: 'BUSINESS_COMMAND_COMPLETE', trialCount: trials.length }));
