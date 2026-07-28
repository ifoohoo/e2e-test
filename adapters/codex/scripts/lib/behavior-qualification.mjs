import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const CHECK_IDS = [
  'help',
  'author-no-binding',
  'review-no-binding',
  'repair-no-binding',
  'author',
  'review',
  'repair',
  're-review',
  'business-decision',
  'bundle-drift',
  'host-swap',
  'caller-lock',
  'default-write-reject',
];
export const WORKFLOW_REQUEST_IDS = [
  'author-initialize',
  'author-compose',
  'author-review-core',
  'author-repair-core',
  'author-reconcile',
  'author-validate',
  'repair-preview',
];

export const QUALIFICATION_SUBJECT_ALGORITHM = 'e2e-test-qualification-subject-v1';
export const QUALIFICATION_EVIDENCE_PATHS = Object.freeze([
  'conformance/behavior-qualification.json',
  'adapters/codex/conformance/behavior-qualification.json',
  'adapters/claude/conformance/behavior-qualification.json',
  'conformance/method-forward-qualification.json',
  'adapters/codex/conformance/method-forward-qualification.json',
  'adapters/claude/conformance/method-forward-qualification.json',
]);
const QUALIFICATION_EVIDENCE_PATH_SET = new Set(QUALIFICATION_EVIDENCE_PATHS);

const EXPECTED = {
  help: { code: 'HELP_READY', exitCode: 0, lock: false, delta: emptyDelta() },
  'author-no-binding': { code: 'NOT_ENABLED', exitCode: 1, lock: false, delta: emptyDelta() },
  'review-no-binding': { code: 'NOT_ENABLED', exitCode: 1, lock: false, delta: emptyDelta() },
  'repair-no-binding': { code: 'NOT_ENABLED', exitCode: 1, lock: false, delta: emptyDelta() },
  author: {
    code: 'AUTHOR_COMPLETE', exitCode: 0, lock: true,
    // M1-A req 6：proof-binding 是 author 的第 4 个正式交付物。
    delta: { added: ['artifacts/e2e/authored.json', 'artifacts/e2e/authored.matrix.json', 'artifacts/e2e/authored.package.json', 'artifacts/e2e/authored.proof.json'], removed: [], modified: [] },
  },
  review: {
    code: 'REVIEW_COMPLETE', exitCode: 0, lock: true, finding: ['E2E-F-005', true], inputStable: true,
    delta: { added: ['reviews/oracle-review.json'], removed: [], modified: [] },
  },
  repair: {
    code: 'REPAIR_COMPLETE', exitCode: 0, lock: true, finding: ['E2E-F-005', false],
    // M1-A req 3：repair 以单一摘要约束事务同步输出三件套。
    delta: { added: ['artifacts/e2e/repaired.json', 'artifacts/e2e/repaired.matrix.json', 'artifacts/e2e/repaired.package.json'], removed: [], modified: [] },
  },
  're-review': {
    code: 'REVIEW_COMPLETE', exitCode: 0, lock: true, finding: ['E2E-F-005', false], delta: emptyDelta(),
  },
  'business-decision': { code: 'REPAIR_NEEDS_INPUT', exitCode: 0, lock: true, delta: emptyDelta() },
  'bundle-drift': { code: 'BUNDLE_DIGEST_MISMATCH', exitCode: 1, lock: false, delta: emptyDelta() },
  'host-swap': { code: 'HOST_MISMATCH', exitCode: 1, lock: false, delta: emptyDelta() },
  'caller-lock': { code: 'CALLER_LOCK_REJECTED', exitCode: 1, lock: false, delta: emptyDelta() },
  'default-write-reject': { code: 'METHOD_QUERY_REJECTED', exitCode: 1, lock: false, delta: emptyDelta() },
};

export function createValidators(schemaRoot) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const resultSchema = JSON.parse(readFileSync(join(schemaRoot, 'behavior-qualification-result.json'), 'utf8'));
  const scenarioSchema = JSON.parse(readFileSync(join(schemaRoot, 'behavior-qualification-scenario.json'), 'utf8'));
  const receiptSchema = JSON.parse(readFileSync(join(schemaRoot, 'behavior-host-receipt.json'), 'utf8'));
  ajv.addSchema(resultSchema);
  return {
    result: ajv.getSchema(resultSchema.$id),
    scenario: ajv.compile(scenarioSchema),
    receipt: ajv.compile(receiptSchema),
  };
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function stableDigest(value) {
  return digestBytes(Buffer.from(JSON.stringify(canonicalize(value))));
}

export function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function buildQualificationSubject(pluginRoot) {
  const root = resolve(pluginRoot);
  const entries = listQualificationSubjectPaths(root).map(path => {
    const full = join(root, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      return { path, type: 'symlink', mode: stat.mode & 0o777, target: readlinkSync(full) };
    }
    let bytes = readFileSync(full);
    if (/(?:^|\/)family\/implementation\.yaml$/.test(path)) {
      bytes = Buffer.from(String(bytes).replace(
        /(^\s*behaviorQualification:\s*)\S+\s*$/m,
        '$1null',
      ));
    }
    return { path, type: 'file', mode: stat.mode & 0o777, size: bytes.length, digest: digestBytes(bytes) };
  });
  return {
    algorithm: QUALIFICATION_SUBJECT_ALGORITHM,
    digest: stableDigest({ algorithm: QUALIFICATION_SUBJECT_ALGORITHM, entries }),
  };
}

/**
 * 返回资格主体覆盖的精确发布文件集合。发布包测试必须复用本函数，不能
 * 复制一套近似的目录遍历规则。
 */
export function listQualificationSubjectPaths(pluginRoot) {
  const root = resolve(pluginRoot);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = ['package.json', ...(packageJson.files ?? [])];
  const paths = new Set();
  for (const item of declared) collectDeclaredPackageFiles(root, resolve(root, item.replace(/\/$/, '')), paths);
  return [...paths].sort().filter(path => !QUALIFICATION_EVIDENCE_PATH_SET.has(path));
}

function collectDeclaredPackageFiles(root, current, paths) {
  if (!existsSync(current)) return;
  const rel = relative(root, current).replaceAll('\\', '/');
  if (rel.startsWith('../') || rel === '..') throw new Error('QUALIFICATION_SUBJECT_PATH_ESCAPE');
  const stat = lstatSync(current);
  if (stat.isDirectory()) {
    for (const name of readdirSync(current).sort()) collectDeclaredPackageFiles(root, join(current, name), paths);
  } else {
    paths.add(rel);
  }
}

export function qualificationErrorCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    const code = String(candidate ?? '').match(/^([A-Z][A-Z0-9_]{2,})/)?.[1];
    if (code) return code;
  }
  return 'QUALIFICATION_FAILED';
}

export function buildClaudeSecuritySettings({
  projectRoot, adapterRoot, consumerRoot, skillPaths,
  exactReadCommand, exactBusinessCommand, exactVerifyCommand, environment,
}) {
  const absoluteReadRule = path => `Read(//${resolve(path).replace(/^\/+/, '')})`;
  const credentialName = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
  const providerPrefix = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|GCP|VERTEX|GITHUB|NPM)_/;
  const protectedEnvNames = Object.keys(environment ?? {})
    .filter(name => credentialName.test(name) || providerPrefix.test(name))
    .sort();
  return {
    permissions: {
      defaultMode: 'dontAsk',
      disableBypassPermissionsMode: 'disable',
      allow: [
        ...skillPaths.map(absoluteReadRule),
        `Bash(${exactReadCommand})`,
        `Bash(${exactBusinessCommand})`,
        `Bash(${exactVerifyCommand})`,
      ],
      deny: ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Bash(git *)'],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [resolve(projectRoot)],
        denyWrite: [resolve(adapterRoot), resolve(consumerRoot)],
        denyRead: [],
        allowRead: [resolve(projectRoot), resolve(adapterRoot), resolve(consumerRoot)],
      },
      credentials: {
        files: [
          '~/.ssh', '~/.aws', '~/.azure', '~/.config/gcloud', '~/.config/gh',
          '~/.npmrc', '~/.netrc', '~/.git-credentials', '~/.claude',
        ].map(path => ({ path, mode: 'deny' })),
        envVars: protectedEnvNames.map(name => ({ name, mode: 'deny' })),
      },
      network: {
        allowedDomains: [],
        deniedDomains: ['*'],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
    },
    autoMemoryEnabled: false,
    fileCheckpointingEnabled: false,
    includeGitInstructions: false,
  };
}

export function finalizeQualificationEvidence({ pluginRoot, result, validateResult, failAfter = null }) {
  if (result?.qualificationStatus !== 'QUALIFIED' || !validateResult?.(result) || !verifyEmbeddedDigest(result)) {
    throw new Error('FINALIZE_REQUIRES_QUALIFIED_RESULT');
  }
  const roots = [
    resolve(pluginRoot),
    resolve(pluginRoot, 'adapters', 'codex'),
    resolve(pluginRoot, 'adapters', 'claude'),
  ];
  const evidenceReference = 'conformance/behavior-qualification.json';
  const expectedSubjects = result.evidence?.qualificationSubjects;
  if (expectedSubjects) {
    for (const [index, root] of roots.entries()) {
      const key = ['root', 'codex', 'claude'][index];
      const expected = expectedSubjects[key];
      const observed = buildQualificationSubject(root);
      if (!expected || observed.algorithm !== expected.algorithm || observed.digest !== expected.digest) {
        throw new Error(`QUALIFICATION_SUBJECT_MISMATCH:${key}`);
      }
    }
  }
  const evidenceContent = `${JSON.stringify(result, null, 2)}\n`;
  const writes = [];
  for (const root of roots) {
    const descriptorPath = join(root, 'family', 'implementation.yaml');
    if (!existsSync(descriptorPath)) throw new Error('FINALIZE_DESCRIPTOR_MISSING');
    const descriptorContent = readFileSync(descriptorPath, 'utf8');
    const current = descriptorContent.match(/^\s*behaviorQualification:\s*(\S+)\s*$/m)?.[1];
    if (!current) throw new Error('DESCRIPTOR_QUALIFICATION_FIELD_MISSING');
    if (current !== 'null' && current !== evidenceReference) throw new Error('QUALIFICATION_ALREADY_FINALIZED');
    const descriptorAfter = descriptorContent.replace(
      /^\s*behaviorQualification:\s*\S+\s*$/m,
      `  behaviorQualification: ${evidenceReference}`,
    );
    const evidencePath = join(root, 'conformance', 'behavior-qualification.json');
    if (existsSync(evidencePath)) {
      let existing;
      try {
        existing = JSON.parse(readFileSync(evidencePath, 'utf8'));
      } catch {
        throw new Error('QUALIFICATION_EVIDENCE_CONFLICT');
      }
      if (existing?.digest !== result.digest &&
          !canReplaceStaleQualificationEvidence(existing, result, validateResult)) {
        throw new Error('QUALIFICATION_EVIDENCE_CONFLICT');
      }
    }
    writes.push({ path: evidencePath, content: evidenceContent });
    writes.push({ path: descriptorPath, content: descriptorAfter });
  }

  const states = writes.map((write, index) => {
    const existed = existsSync(write.path);
    const mode = existed ? statSync(write.path).mode & 0o777 : 0o644;
    const before = existed ? readFileSync(write.path) : null;
    const temp = `${write.path}.qualification-${process.pid}-${index}.tmp`;
    return { ...write, existed, mode, before, temp };
  });
  const unchanged = states.every(state => state.existed && state.before.equals(Buffer.from(state.content)));
  if (unchanged) return { status: 'NOOP', digest: result.digest };

  try {
    for (const state of states) {
      mkdirSync(dirname(state.path), { recursive: true });
      writeFileSync(state.temp, state.content, { mode: state.mode });
      chmodSync(state.temp, state.mode);
    }
    let committed = 0;
    for (const state of states) {
      renameSync(state.temp, state.path);
      committed += 1;
      if (failAfter !== null && committed === failAfter) throw new Error('FINALIZE_INJECTED_FAILURE');
    }
    if (expectedSubjects) {
      for (const [index, root] of roots.entries()) {
        const key = ['root', 'codex', 'claude'][index];
        const expected = expectedSubjects[key];
        const observed = buildQualificationSubject(root);
        if (!expected || observed.algorithm !== expected.algorithm || observed.digest !== expected.digest) {
          throw new Error(`QUALIFICATION_SUBJECT_CHANGED:${key}`);
        }
      }
    }
    return { status: 'FINALIZED', digest: result.digest };
  } catch (error) {
    for (const [index, state] of states.entries()) {
      try {
        if (state.existed) {
          const rollback = `${state.path}.rollback-${process.pid}-${index}.tmp`;
          writeFileSync(rollback, state.before, { mode: state.mode });
          chmodSync(rollback, state.mode);
          renameSync(rollback, state.path);
        } else if (existsSync(state.path)) {
          rmSync(state.path);
        }
      } catch {}
      try { if (existsSync(state.temp)) rmSync(state.temp); } catch {}
    }
    throw error;
  } finally {
    for (const state of states) {
      try { if (existsSync(state.temp)) rmSync(state.temp); } catch {}
    }
  }
}

function canReplaceStaleQualificationEvidence(existing, replacement, validateResult) {
  if (existing?.qualificationStatus !== 'QUALIFIED' ||
      !validateResult?.(existing) ||
      !verifyEmbeddedDigest(existing)) {
    return false;
  }
  const previous = existing.evidence?.qualificationSubjects;
  const next = replacement.evidence?.qualificationSubjects;
  if (!previous || !next) return false;
  const keys = ['root', 'codex', 'claude'];
  if (!keys.every(key => previous[key]?.algorithm && previous[key]?.digest &&
      next[key]?.algorithm && next[key]?.digest)) {
    return false;
  }
  // 同一受测主体产生不同摘要说明认证不确定，必须阻断。只有技能包主体
  // 已变化、旧证据确实陈旧时，才允许用新的双宿主认证原子轮换。
  return keys.some(key =>
    previous[key].algorithm !== next[key].algorithm ||
    previous[key].digest !== next[key].digest
  );
}

export function verifyEmbeddedDigest(value) {
  if (!value || typeof value !== 'object' || typeof value.digest !== 'string') return false;
  const { digest, ...unsigned } = value;
  return stableDigest(unsigned) === digest;
}

export function snapshotTree(root) {
  const entries = [];
  walk(resolve(root), resolve(root), entries);
  return { entries, digest: stableDigest(entries) };
}

function walk(root, current, entries) {
  for (const name of readdirSync(current).sort()) {
    const full = join(current, name);
    const rel = relative(root, full).replaceAll('\\', '/');
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      entries.push({ path: rel, type: 'symlink', mode: stat.mode & 0o777, target: readlinkSync(full) });
    } else if (stat.isDirectory()) {
      entries.push({ path: rel, type: 'directory', mode: stat.mode & 0o777 });
      walk(root, full, entries);
    } else if (stat.isFile()) {
      entries.push({ path: rel, type: 'file', mode: stat.mode & 0o777, size: stat.size, digest: digestBytes(readFileSync(full)) });
    }
  }
}

export function parseCodexEvents(stdout) {
  const events = parseJsonLines(stdout);
  const tools = [];
  let receipt = null;
  for (const [index, event] of events.entries()) {
    const item = event?.item;
    if (event?.type === 'item.completed' && item?.type === 'command_execution') {
      const exitCode = item.exit_code ?? item.exitCode;
      tools.push({
        index, kind: 'command', value: item.command ?? '',
        success: exitCode === 0 && !['failed', 'cancelled', 'incomplete'].includes(item.status),
        resultCode: forwardResultCode(item.aggregated_output ?? item.output ?? ''),
      });
    }
    if (event?.type === 'item.completed' && item?.type === 'file_change') {
      for (const change of item.changes ?? []) {
        tools.push({
          index, kind: 'write', value: change.path ?? '',
          success: item.status === 'completed' && ['add', 'update'].includes(change.kind),
        });
      }
    }
    if (event?.type === 'item.completed' && item?.type && !['command_execution', 'file_change', 'agent_message', 'reasoning', 'error'].includes(item.type)) {
      tools.push({ index, kind: 'other', value: item.type });
    }
    if (event?.type === 'item.completed' && item?.type === 'agent_message') {
      receipt = parseMaybeJson(item.text) ?? receipt;
    }
  }
  return { events, tools: dedupeTools(tools), receipt };
}

export function parseClaudeEvents(stdout) {
  const events = parseJsonLines(stdout);
  const tools = [];
  const toolResults = new Map();
  let receipt = null;
  for (const [index, event] of events.entries()) {
    if (event?.type === 'assistant') {
      for (const block of event?.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue;
        if (block.name === 'Read') tools.push({ index, id: block.id, kind: 'read', value: block.input?.file_path ?? '', success: false });
        else if (block.name === 'Write') tools.push({ index, id: block.id, kind: 'write', value: block.input?.file_path ?? '', success: false });
        else if (block.name === 'Bash') tools.push({ index, id: block.id, kind: 'command', value: block.input?.command ?? '', success: false });
        else if (block.name === 'StructuredOutput') receipt = block.input ?? receipt;
        else tools.push({ index, id: block.id, kind: 'other', value: block.name ?? 'unknown', success: false });
      }
    }
    if (event?.type === 'user') {
      for (const block of event?.message?.content ?? []) {
        if (block?.type === 'tool_result' && block.tool_use_id) toolResults.set(block.tool_use_id, {
          success: block.is_error !== true,
          resultCode: forwardResultCode(block.content),
        });
      }
    }
    if (event?.type === 'result') {
      receipt = event.structured_output ?? parseMaybeJson(event.result) ?? receipt;
    }
  }
  for (const tool of tools) {
    const result = toolResults.get(tool.id);
    tool.success = result?.success === true;
    if (result?.resultCode) tool.resultCode = result.resultCode;
  }
  return { events, tools: dedupeTools(tools), receipt };
}

function forwardResultCode(value) {
  const text = Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item?.text || '').join('\n')
    : typeof value === 'string' ? value : JSON.stringify(value || '');
  return text.match(/"code"\s*:\s*"(FORWARD_[A-Z0-9_]+)"/)?.[1] || null;
}

function parseJsonLines(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) throw new Error('EMPTY_EVENT_STREAM');
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`INVALID_EVENT_JSON_LINE_${index + 1}`); }
  });
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function dedupeTools(tools) {
  const seen = new Set();
  return tools.filter(tool => {
    const key = `${tool.index}:${tool.kind}:${tool.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateToolTrace({ tools, skillPaths, expectedReadCommand, expectedBusinessCommand, expectedVerifyCommand }) {
  const exact = (left, right) => canonicalTraceCommand(left) === canonicalTraceCommand(right);
  const succeeded = tool => tool.success === true;
  const isBusiness = tool => tool.kind === 'command' && exact(tool.value, expectedBusinessCommand) && succeeded(tool);
  const isVerify = tool => tool.kind === 'command' && exact(tool.value, expectedVerifyCommand) && succeeded(tool);
  const isExactReadCommand = tool => tool.kind === 'command' && exact(tool.value, expectedReadCommand) && succeeded(tool);
  const isExactReadEvent = tool => tool.kind === 'read' && succeeded(tool) && skillPaths.some(skillPath => resolve(tool.value) === resolve(skillPath));
  const businessIndex = tools.findIndex(isBusiness);
  const verifyIndex = tools.findIndex(isVerify);
  const readCommandIndex = tools.findIndex(isExactReadCommand);
  const reads = skillPaths.map(skillPath => tools.findIndex(tool =>
    tool.kind === 'read' && resolve(tool.value) === resolve(skillPath)));
  const allReadBeforeBusiness = reads.every(index => index >= 0 && (businessIndex < 0 || index < businessIndex));
  const exactCommandBeforeBusiness = readCommandIndex >= 0 && (businessIndex < 0 || readCommandIndex < businessIndex);
  const orderVerified = businessIndex >= 0 && verifyIndex > businessIndex;
  const normalizedTrace = {
    skillReads: skillPaths.map((_, index) => reads[index] >= 0 || readCommandIndex >= 0),
    readMode: readCommandIndex >= 0 ? 'exact-command' : 'exact-read-events',
    businessCommand: businessIndex >= 0,
    verifyCommand: verifyIndex >= 0,
    orderVerified,
  };
  return {
    skillReadsVerified: allReadBeforeBusiness || exactCommandBeforeBusiness,
    businessCommandsVerified: businessIndex >= 0,
    scenarioCommandVerified: orderVerified,
    unexpectedToolsDetected: tools.some(tool => !isBusiness(tool) && !isVerify(tool) && !isExactReadCommand(tool) && !isExactReadEvent(tool)),
    toolEventsDigest: stableDigest(normalizedTrace),
  };
}

export function validateScenario(scenario, host, validateSchema) {
  const errors = [];
  if (!validateSchema(scenario)) errors.push(`SCHEMA:${formatAjvErrors(validateSchema.errors)}`);
  if (!verifyEmbeddedDigest(scenario)) errors.push('DIGEST_MISMATCH');
  if (scenario?.host !== host) errors.push('HOST_MISMATCH');
  if (scenario?.status !== 'PASS') errors.push('STATUS_NOT_PASS');
  const fixtureNames = scenario?.identity?.fixtureDigests?.map(item => item.name);
  if (JSON.stringify(fixtureNames) !== JSON.stringify(['artifact.json', 'candidate-assessment.json', 'inspection.json', 'matrix.json'])) {
    errors.push('FIXTURE_SET_MISMATCH');
  }
  const checks = Array.isArray(scenario?.checks) ? scenario.checks : [];
  const ids = checks.map(check => check.id);
  if (JSON.stringify(ids) !== JSON.stringify(CHECK_IDS)) errors.push('CHECK_SET_MISMATCH');
  for (const check of checks) {
    const expected = EXPECTED[check.id];
    if (!expected) continue;
    if (check.hostId !== host || check.status !== 'PASS' || check.code !== expected.code ||
        check.exitCode !== expected.exitCode || check.runLockReverified !== expected.lock ||
        JSON.stringify(check.filesystemDelta) !== JSON.stringify(expected.delta)) {
      errors.push(`SEMANTIC_MISMATCH:${check.id}`);
    }
    if (expected.finding && (check.finding?.rule !== expected.finding[0] || check.finding?.present !== expected.finding[1])) {
      errors.push(`FINDING_MISMATCH:${check.id}`);
    }
    if (expected.inputStable === true && check.inputDigestStable !== true) errors.push(`INPUT_MUTATED:${check.id}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateScenarioIdentity(identity, expected) {
  const errors = [];
  for (const key of [
    'familyApiRevision', 'contractRevision', 'implementationId', 'implementationVersion',
    'qualificationInputTarballDigest', 'qualificationSubjectDigest',
    'bundleDigest', 'deterministicAttestation',
  ]) {
    if (identity?.[key] !== expected?.[key]) errors.push(`IDENTITY_MISMATCH:${key}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateCrossHostIdentity(codexIdentity, claudeIdentity) {
  const errors = [];
  for (const key of [
    'familyApiRevision', 'contractRevision', 'implementationId', 'implementationVersion',
    'qualificationInputTarballDigest',
  ]) {
    if (codexIdentity?.[key] !== claudeIdentity?.[key]) errors.push(`CROSS_HOST_IDENTITY_MISMATCH:${key}`);
  }
  if (stableDigest(codexIdentity?.fixtureDigests ?? null) !== stableDigest(claudeIdentity?.fixtureDigests ?? null)) {
    errors.push('CROSS_HOST_FIXTURE_MISMATCH');
  }
  return { valid: errors.length === 0, errors };
}

export function classifyHost({ timedOut, exitCode, trace, receiptValid, scenarioValid, packageUnmodified, inputsUnmodified, unauthorizedWriteDetected, absolutePathDetected }) {
  if (timedOut) return 'TIMEOUT';
  if (exitCode !== 0) return 'NOT_QUALIFIED';
  if (!trace.skillReadsVerified) return 'SKILL_READS_MISSING';
  if (!trace.businessCommandsVerified) return 'BUSINESS_COMMANDS_MISSING';
  if (!trace.scenarioCommandVerified) return 'COMMAND_MISSING';
  if (trace.unexpectedToolsDetected) return 'UNEXPECTED_TOOLS';
  if (!receiptValid) return 'RECEIPT_INVALID';
  if (!scenarioValid) return 'SCENARIO_INVALID';
  if (!packageUnmodified) return 'PACKAGE_MUTATED';
  if (!inputsUnmodified) return 'INPUT_MUTATED';
  if (unauthorizedWriteDetected) return 'EXTRA_WRITES';
  if (absolutePathDetected) return 'PATH_LEAK';
  return 'QUALIFIED';
}

export function qualificationStatus(hosts, trialCount, crossHostIdentityValid = true) {
  return hosts.codex?.status === 'QUALIFIED' && hosts.claude?.status === 'QUALIFIED' &&
      trialCount === 26 && crossHostIdentityValid
    ? 'QUALIFIED'
    : 'NOT_QUALIFIED';
}

function canonicalTraceCommand(value) {
  if (typeof value !== 'string') return null;
  let command = value.trim();
  const wrapped = command.match(/^\/(?:bin\/)?(?:zsh|bash) -lc "([\s\S]*)"$/);
  if (wrapped) command = wrapped[1];
  return command
    .replace(/[\\'\"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expectedProjectFiles(host) {
  return [
    'artifacts/e2e/authored.json',
    'artifacts/e2e/authored.matrix.json',
    'artifacts/e2e/authored.package.json',
    // M1-A req 6：proof-binding 是第 4 个正式交付物。
    'artifacts/e2e/authored.proof.json',
    // M1-A req 3：repair 三件套同步输出。
    'artifacts/e2e/repaired.json',
    'artifacts/e2e/repaired.matrix.json',
    'artifacts/e2e/repaired.package.json',
    'fixtures/artifact.json',
    'fixtures/candidate-assessment.json',
    // M1-A req 1：语义 fixtures 以三件套（artifact/matrix/package manifest）落盘。
    'fixtures/happy-only-artifact.json',
    'fixtures/happy-only-artifact.matrix.json',
    'fixtures/happy-only-artifact.package.json',
    'fixtures/inspection.json',
    'fixtures/internal-oracle-artifact.json',
    'fixtures/internal-oracle-artifact.matrix.json',
    'fixtures/internal-oracle-artifact.package.json',
    'fixtures/matrix.json',
    `qualification-results/${host}.json`,
    'qualification-control/business-command.ok',
    'qualification-control/prepared.json',
    ...[...CHECK_IDS, 'business-review'].map(id => `qualification-results/trials/${id}.json`),
    ...CHECK_IDS.map(id => `requests/${id}.json`),
    'requests/business-review.json',
    'reviews/business-review.json',
    'reviews/oracle-review.json',
  ].sort();
}

export function projectFiles(snapshot) {
  return snapshot.entries.filter(entry => entry.type !== 'directory').map(entry => entry.path).sort();
}

export function containsAbsolutePath(value) {
  if (typeof value === 'string') return /^\/(?!\/)|^[A-Za-z]:[\\/]/.test(value) || /(?:^|\s)\/(?:[^\s"']+\/)+[^\s"']*/.test(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

export function formatAjvErrors(errors = []) {
  return errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

function emptyDelta() {
  return { added: [], removed: [], modified: [] };
}
