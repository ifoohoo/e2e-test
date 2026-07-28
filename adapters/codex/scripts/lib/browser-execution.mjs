/**
 * M5 受控 Playwright 执行与唯一 canonical finalizer。
 *
 * ExecutionPlan 只从 M4-D 同进程成功 commit 产生。runner/network observer/
 * teardown inspector/readiness probe 都属于宿主私有 controller，测试代码与调用方
 * 不能提交 summary、networkEscape、cleanupStatus 或 canonical status。
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { readTrustedImplementationCommitContext } from './browser-implementation-commit.mjs';
import { prepareImplementationPlan } from './browser-implementation-planner.mjs';
import { stableDigest } from './digest.mjs';
import { validateSchema } from './schema-validation.mjs';

const TRUSTED_EXECUTION_PLANS = new WeakMap();
const FACT_KEY = randomBytes(32);
const FACT_KEY_ID = 'e2e-test-execution-facts-v1';
const FRESHNESS_LEDGER = new Map();
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export const EXECUTION_FAILURE_CODES = Object.freeze({
  M5_PLAN_COMMIT_UNTRUSTED: 'M5_PLAN_COMMIT_UNTRUSTED',
  M5_PLAN_CONFIG_INVALID: 'M5_PLAN_CONFIG_INVALID',
  M5_PLAN_NETWORK_UNSAFE: 'M5_PLAN_NETWORK_UNSAFE',
  M5_PLAN_SECRET_INVALID: 'M5_PLAN_SECRET_INVALID',
  M5_PLAN_SCHEMA_INVALID: 'M5_PLAN_SCHEMA_INVALID',
  M5_BINDING_STALE: 'M5_BINDING_STALE',
  M5_CONTROLLER_INVALID: 'M5_CONTROLLER_INVALID',
  M5_HANDLE_INVALID: 'M5_HANDLE_INVALID',
  M5_HANDLE_EXPIRED: 'M5_HANDLE_EXPIRED',
  M5_HANDLE_SECRET_MISMATCH: 'M5_HANDLE_SECRET_MISMATCH',
  M5_HANDLE_SCOPE_MISMATCH: 'M5_HANDLE_SCOPE_MISMATCH',
  M5_HANDLE_REPLAYED: 'M5_HANDLE_REPLAYED',
  M5_PREFLIGHT_BLOCKED: 'M5_PREFLIGHT_BLOCKED',
  M5_LIFECYCLE_ADAPTER_FAILED: 'M5_LIFECYCLE_ADAPTER_FAILED',
  M5_READINESS_BLOCKED: 'M5_READINESS_BLOCKED',
  M5_RUNNER_FAILED: 'M5_RUNNER_FAILED',
  M5_REPORTER_MISSING: 'M5_REPORTER_MISSING',
  M5_REPORTER_INVALID: 'M5_REPORTER_INVALID',
  M5_NETWORK_OBSERVER_FAILED: 'M5_NETWORK_OBSERVER_FAILED',
  M5_RESOURCE_OBSERVER_FAILED: 'M5_RESOURCE_OBSERVER_FAILED',
  M5_TEARDOWN_INSPECTOR_FAILED: 'M5_TEARDOWN_INSPECTOR_FAILED',
  M5_RESULT_SCHEMA_INVALID: 'M5_RESULT_SCHEMA_INVALID',
});

function failure(code, violations, extra = {}) {
  return {
    ok: false,
    status: 'BLOCKED',
    code,
    violations: [...new Set((violations || []).map(String))],
    ...extra,
  };
}

function rawDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function unsigned(value, field) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => key !== field),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schemaValid(pluginRoot, schemaFile, value) {
  try {
    return validateSchema(pluginRoot, schemaFile, value).valid;
  } catch {
    return false;
  }
}

function defaultPort(url) {
  if (url.port) return Number(url.port);
  return ['https:', 'wss:'].includes(url.protocol) ? 443 : 80;
}

function loopback(host) {
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost');
}

function safeNonProductionHost(host) {
  if (host.endsWith('.test') || host.endsWith('.internal')) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 10 ||
      octets[0] === 127 ||
      octets[0] === 192 && octets[1] === 168 ||
      octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
  }
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd');
}

function normalizeAllowlistEntry(entry) {
  if (!entry || typeof entry !== 'object' ||
      !['http', 'https', 'ws', 'wss'].includes(entry.scheme) ||
      typeof entry.host !== 'string' ||
      !Number.isInteger(entry.port) ||
      entry.port < 1 || entry.port > 65535) return null;
  const host = entry.host.toLowerCase().replace(/\.$/, '');
  if (!loopback(host) && !safeNonProductionHost(host)) return null;
  const pathPrefix = entry.pathPrefix === undefined ? '/' : entry.pathPrefix;
  if (typeof pathPrefix !== 'string' ||
      !pathPrefix.startsWith('/') ||
      pathPrefix.includes('\\') ||
      pathPrefix.includes('\0') ||
      pathPrefix.split('/').includes('..')) return null;
  return {
    scheme: entry.scheme,
    host,
    port: entry.port,
    pathPrefix,
  };
}

function targetAllowed(rawTarget, allowlist) {
  let url;
  try {
    url = new URL(rawTarget);
  } catch {
    return { allowed: false, normalizedTarget: '', reason: 'URL_INVALID' };
  }
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = defaultPort(url);
  const path = url.pathname || '/';
  const normalizedTarget = `${scheme}://${host}:${port}${path}`;
  const match = allowlist.find(entry =>
    entry.scheme === scheme &&
    entry.host === host &&
    entry.port === port &&
    (path === entry.pathPrefix ||
      entry.pathPrefix === '/' ||
      path.startsWith(`${entry.pathPrefix.replace(/\/$/, '')}/`)));
  return {
    allowed: Boolean(match),
    normalizedTarget,
    reason: match ? 'ALLOWLIST_MATCH' : 'ALLOWLIST_MISS',
  };
}

function exactSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) ||
      new Set(left).size !== left.length ||
      new Set(right).size !== right.length ||
      left.length !== right.length) return false;
  const set = new Set(right);
  return left.every(value => set.has(value));
}

export function prepareExecutionPlan(input = {}) {
  const {
    commitResult,
    baseURL,
    readinessURL = baseURL,
    allowlist = [],
    envWhitelist = [],
    secretHandles = [],
    timeouts = { test: 30000, total: 300000 },
    workers = 1,
    resources = { cpu: 1, memMB: 1024 },
    browser = { engine: 'chromium', channel: 'playwright' },
    artifactPolicy = {
      trace: 'on',
      screenshot: 'only-on-failure',
    },
  } = input;
  const context = readTrustedImplementationCommitContext(commitResult);
  if (!context) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_COMMIT_UNTRUSTED,
      ['只接受 M4-D 同进程 READY_TO_RUN commit'],
    );
  }
  let base;
  let readiness;
  try {
    base = new URL(baseURL);
    readiness = new URL(readinessURL);
  } catch {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_CONFIG_INVALID,
      ['baseURL/readinessURL 必须是绝对 URL'],
    );
  }
  if (!['http:', 'https:'].includes(base.protocol) ||
      !['http:', 'https:'].includes(readiness.protocol) ||
      base.username || base.password || readiness.username || readiness.password) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_NETWORK_UNSAFE,
      ['URL scheme/credential 不安全'],
    );
  }
  const normalizedAllowlist = allowlist.map(normalizeAllowlistEntry);
  if (normalizedAllowlist.some(item => !item)) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_NETWORK_UNSAFE,
      ['allowlist 含生产/公共主机或不规范条目'],
    );
  }
  const baseEntry = {
    scheme: base.protocol.slice(0, -1),
    host: base.hostname.toLowerCase().replace(/\.$/, ''),
    port: defaultPort(base),
    pathPrefix: '/',
  };
  const effectiveAllowlist = loopback(baseEntry.host)
    ? [baseEntry, ...normalizedAllowlist]
    : normalizedAllowlist;
  if (!targetAllowed(base.href, effectiveAllowlist).allowed ||
      !targetAllowed(readiness.href, effectiveAllowlist).allowed) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_NETWORK_UNSAFE,
      ['baseURL/readinessURL 不在安全 allowlist'],
    );
  }
  if (!Array.isArray(envWhitelist) ||
      new Set(envWhitelist).size !== envWhitelist.length ||
      envWhitelist.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name)) ||
      !Array.isArray(secretHandles) ||
      new Set(secretHandles).size !== secretHandles.length ||
      secretHandles.some(handle =>
        typeof handle !== 'string' ||
        !/^[A-Z][A-Z0-9_]*=[a-zA-Z0-9._:/-]+$/.test(handle))) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_SECRET_INVALID,
      ['env whitelist/secret handle 格式或唯一性无效'],
    );
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > 4 ||
      !Number.isInteger(timeouts.test) || timeouts.test < 1 ||
      !Number.isInteger(timeouts.total) || timeouts.total < timeouts.test ||
      timeouts.total > 1800000 ||
      typeof resources.cpu !== 'number' || resources.cpu <= 0 ||
      !Number.isInteger(resources.memMB) || resources.memMB < 128 ||
      browser?.engine !== 'chromium' ||
      !['playwright', 'chrome'].includes(browser?.channel) ||
      artifactPolicy?.trace !== 'on' ||
      artifactPolicy?.screenshot !== 'only-on-failure') {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_CONFIG_INVALID,
      ['worker/timeout/resource 预算无效'],
    );
  }
  const binding = commitResult.bindingManifest;
  const files = binding.bindings.map(item => item.file);
  const caseIds = binding.bindings.map(item => item.caseId);
  if (!exactSet(files, [...new Set(files)]) ||
      files.some(file =>
        isAbsolute(file) ||
        file.includes('\\') ||
        file.split('/').includes('..') ||
        !/\.spec\.(?:ts|js)$/.test(file))) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_CONFIG_INVALID,
      ['BindingManifest 文件选择不安全或重复'],
    );
  }
  const planUnsigned = {
    planId: `execution-plan@${stableDigest({
      bindingDigest: binding.bindingDigest,
      baseURL: base.href,
      files,
    }).slice('sha256:'.length)}`,
    bindingDigest: binding.bindingDigest,
    profileDigest: context.context.planningPreview.plan.profileDigest,
    testSelection: { fileGlobs: files, caseIds },
    command: {
      runner: 'playwright-test',
      invocation: 'node_modules/.bin/playwright',
      args: [
        'test',
        '--reporter=json,junit,blob',
        '--workers',
        String(workers),
        '--retries',
        '0',
        '--timeout',
        String(timeouts.test),
        '--global-timeout',
        String(timeouts.total),
        '--forbid-only',
        '--trace',
        artifactPolicy.trace,
        ...files,
      ],
    },
    ...(context.context.planningInput.profile.startCommand
      ? { startCommand: context.context.planningInput.profile.startCommand }
      : {}),
    baseURL: base.href,
    readiness: {
      url: readiness.href,
      timeoutMs: Math.min(timeouts.test, 30000),
      expectedStatus: 200,
    },
    allowlist: effectiveAllowlist,
    envWhitelist,
    secretHandles,
    timeouts,
    workers,
    retries: 0,
    resources,
    browser,
    artifactPolicy,
  };
  const plan = deepFreeze({
    ...planUnsigned,
    planDigest: stableDigest(planUnsigned),
  });
  if (!schemaValid(context.context.pluginRoot, 'execution-plan.json', plan)) {
    return failure(
      EXECUTION_FAILURE_CODES.M5_PLAN_SCHEMA_INVALID,
      ['ExecutionPlan schema 无效'],
    );
  }
  TRUSTED_EXECUTION_PLANS.set(plan, context);
  return {
    ok: true,
    status: 'EXECUTION_PLAN_READY',
    code: 'EXECUTION_PLAN_READY',
    plan,
    writesPerformed: 0,
  };
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function localPlaywright(root) {
  try {
    const target = resolve(root, 'node_modules/.bin/playwright');
    if (!existsSync(target)) return null;
    const resolved = realpathSync(target);
    return inside(root, resolved) && statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function safeOutputRoot(root, runId) {
  const ref = `.artifact-graph/runs/e2e-test/${runId}`;
  try {
    let current = root;
    for (const segment of ref.split('/')) {
      current = resolve(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) return null;
    }
    if (!inside(root, current)) return null;
    mkdirSync(current, { recursive: true });
    return { ref, path: current };
  } catch {
    return null;
  }
}

function reporterPaths(output) {
  return {
    json: `${output.ref}/results.json`,
    junit: `${output.ref}/junit.xml`,
    blob: `${output.ref}/blob.zip`,
  };
}

function runtimePaths(output) {
  return {
    config: `${output.ref}/playwright.runtime.config.mjs`,
    artifacts: `${output.ref}/artifacts`,
  };
}

function writeSetForRun(runId) {
  const output = { ref: `.artifact-graph/runs/e2e-test/${runId}` };
  return [
    ...Object.values(reporterPaths(output)),
    ...Object.values(runtimePaths(output)),
  ].sort();
}

function writeRuntimeConfig(root, output, plan) {
  const paths = runtimePaths(output);
  const artifactPath = resolve(root, paths.artifacts);
  mkdirSync(artifactPath, { recursive: true });
  const config = {
    testDir: root,
    forbidOnly: true,
    fullyParallel: false,
    retries: 0,
    workers: plan.workers,
    timeout: plan.timeouts.test,
    globalTimeout: plan.timeouts.total,
    outputDir: artifactPath,
    use: {
      baseURL: plan.baseURL,
      trace: plan.artifactPolicy.trace,
      screenshot: plan.artifactPolicy.screenshot,
      ...(plan.browser.channel === 'chrome' ? { channel: 'chrome' } : {}),
    },
  };
  const bytes = [
    "import { defineConfig } from '@playwright/test';",
    `export default defineConfig(${JSON.stringify(config)});`,
    '',
  ].join('\n');
  const configPath = resolve(root, paths.config);
  writeFileSync(configPath, bytes, { flag: 'wx', mode: 0o600 });
  return {
    ...paths,
    configPath,
    artifactPath,
    configDigest: rawDigest(Buffer.from(bytes)),
  };
}

function collectArtifactFiles(root, artifactRootRef) {
  const artifactRoot = resolve(root, artifactRootRef);
  if (!inside(root, artifactRoot) || !existsSync(artifactRoot) ||
      !lstatSync(artifactRoot).isDirectory() ||
      lstatSync(artifactRoot).isSymbolicLink()) {
    return { ok: false, traces: [], screenshots: [] };
  }
  const files = [];
  const pending = [artifactRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory).sort()) {
      const target = resolve(directory, name);
      if (!inside(artifactRoot, target)) return { ok: false, traces: [], screenshots: [] };
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) return { ok: false, traces: [], screenshots: [] };
      if (stat.isDirectory()) {
        pending.push(target);
      } else if (stat.isFile()) {
        const ref = relative(root, target).split(sep).join('/');
        files.push({ path: ref, digest: rawDigest(readFileSync(target)) });
      }
    }
  }
  const traces = files.filter(item => item.path.endsWith('/trace.zip'));
  const screenshots = files.filter(item => /\.(?:png|jpe?g)$/i.test(item.path));
  return { ok: true, traces, screenshots };
}

function resultStatus(results) {
  const statuses = (results || []).map(item => item?.status);
  if (statuses.some(status =>
    ['failed', 'timedOut', 'interrupted'].includes(status))) return 'fail';
  if (statuses.includes('passed')) return 'pass';
  return 'skip';
}

function collectSpecs(suites, output = []) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      const statuses = tests.map(test => resultStatus(test.results));
      output.push({
        title: spec.title,
        status: statuses.includes('fail')
          ? 'fail'
          : statuses.includes('pass') ? 'pass' : 'skip',
      });
    }
    collectSpecs(suite.suites, output);
  }
  return output;
}

function parseReport(root, refs) {
  const reporters = [];
  for (const [kind, ref] of Object.entries(refs)) {
    const target = resolve(root, ref);
    if (!inside(root, target) || !existsSync(target) || !lstatSync(target).isFile()) {
      return { ok: false, code: EXECUTION_FAILURE_CODES.M5_REPORTER_MISSING, kind };
    }
    reporters.push({ path: ref, digest: rawDigest(readFileSync(target)) });
  }
  let json;
  try {
    json = JSON.parse(readFileSync(resolve(root, refs.json), 'utf8'));
  } catch {
    return { ok: false, code: EXECUTION_FAILURE_CODES.M5_REPORTER_INVALID };
  }
  const stats = json.stats || {};
  for (const field of ['expected', 'unexpected', 'flaky', 'skipped']) {
    if (!Number.isInteger(stats[field]) || stats[field] < 0) {
      return { ok: false, code: EXECUTION_FAILURE_CODES.M5_REPORTER_INVALID };
    }
  }
  return {
    ok: true,
    reporters,
    summary: {
      run: stats.expected + stats.unexpected + stats.flaky + stats.skipped,
      pass: stats.expected,
      fail: stats.unexpected + stats.flaky,
      skip: stats.skipped,
    },
    specs: collectSpecs(json.suites),
  };
}

function attestFact(unsignedFact) {
  const mac = `sha256:${createHmac('sha256', FACT_KEY)
    .update(JSON.stringify(unsignedFact)).digest('hex')}`;
  const withAttestation = {
    ...unsignedFact,
    attestation: {
      algorithm: 'HMAC-SHA256',
      keyId: FACT_KEY_ID,
      mac,
    },
  };
  return {
    ...withAttestation,
    selfDigest: stableDigest(withAttestation),
  };
}

function factValid(fact, expectedScope = {}) {
  if (!fact || typeof fact !== 'object' ||
      fact.attestation?.algorithm !== 'HMAC-SHA256' ||
      fact.attestation?.keyId !== FACT_KEY_ID ||
      !DIGEST_RE.test(fact.attestation?.mac || '') ||
      stableDigest(unsigned(fact, 'selfDigest')) !== fact.selfDigest) return false;
  const factWithoutDigest = unsigned(fact, 'selfDigest');
  const signed = unsigned(factWithoutDigest, 'attestation');
  const expected = createHmac('sha256', FACT_KEY)
    .update(JSON.stringify(signed)).digest();
  const actual = Buffer.from(fact.attestation.mac.slice('sha256:'.length), 'hex');
  if (actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)) return false;
  return Object.entries(expectedScope)
    .every(([field, value]) => fact[field] === value);
}

function makeNetworkFact(plan, runId, observations) {
  const entries = observations.map((observation, index) => {
    const checked = targetAllowed(observation.url, plan.allowlist);
    return {
      originalTarget: observation.url,
      normalizedTarget: checked.normalizedTarget,
      allowed: checked.allowed,
      reason: checked.reason,
      hop: Number.isInteger(observation.hop) ? observation.hop : index,
    };
  });
  return attestFact({
    factId: `network@${runId}`,
    planDigest: plan.planDigest,
    runId,
    entries,
    hasEscape: entries.some(item => !item.allowed),
  });
}

function makeResourceFact(plan, runId, observed) {
  if (!observed ||
      typeof observed.mechanism !== 'string' ||
      observed.mechanism.length === 0 ||
      typeof observed.cpuPeak !== 'number' ||
      !Number.isFinite(observed.cpuPeak) ||
      observed.cpuPeak < 0 ||
      typeof observed.memPeakMB !== 'number' ||
      !Number.isFinite(observed.memPeakMB) ||
      observed.memPeakMB < 0) return null;
  const budget = {
    cpu: plan.resources.cpu,
    memMB: plan.resources.memMB,
  };
  const usage = {
    cpuPeak: observed.cpuPeak,
    memPeakMB: observed.memPeakMB,
  };
  return attestFact({
    factId: `resources@${runId}`,
    planDigest: plan.planDigest,
    runId,
    mechanism: observed.mechanism,
    budget,
    usage,
    withinBudget:
      usage.cpuPeak <= budget.cpu &&
      usage.memPeakMB <= budget.memMB,
  });
}

function currentBindingValid(root, context) {
  const currentPlan = prepareImplementationPlan(context.context.planningInput);
  if (!currentPlan.ok ||
      currentPlan.plan.planDigest !== context.commitPreview.planDigest ||
      currentPlan.plan.profileDigest !==
        context.context.planningPreview.plan.profileDigest) {
    return false;
  }
  const binding = context.commitResult.bindingManifest;
  const generatedById = new Map(
    context.context.preview.generatedTests.map(item => [item.caseId, item]),
  );
  for (const item of binding.bindings) {
    const generated = generatedById.get(item.caseId);
    const target = resolve(root, item.file);
    if (!generated ||
        binding.generatedTestDigests[item.caseId] !== generated.testDigest ||
        !inside(root, target) ||
        !existsSync(target)) return false;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (rawDigest(readFileSync(target)) !== generated.contentDigest) return false;
  }
  return true;
}

function makeTeardown(plan, observed) {
  if (!observed ||
      !Array.isArray(observed.processes) ||
      !Array.isArray(observed.ports) ||
      observed.processes.some(item =>
        !item || !Number.isInteger(item.pid) ||
        typeof item.kind !== 'string' || item.kind.length === 0 ||
        typeof item.started !== 'boolean' ||
        typeof item.stopped !== 'boolean') ||
      observed.ports.some(item =>
        !item || !Number.isInteger(item.port) ||
        item.port < 1 || item.port > 65535 ||
        typeof item.freed !== 'boolean')) return null;
  const processes = observed.processes.map(item => ({
    pid: item.pid,
    kind: item.kind,
    started: item.started,
    stopped: item.stopped,
  }));
  const ports = observed.ports.map(item => ({
    port: item.port,
    freed: item.freed,
  }));
  const orphanProcesses = processes.filter(item => !item.stopped)
    .map(item => `${item.kind}:${item.pid}`);
  const residualPorts = ports.filter(item => !item.freed).map(item => item.port);
  const receiptUnsigned = {
    planDigest: plan.planDigest,
    processes,
    ports,
    orphanProcesses,
    residualPorts,
    cleanupStatus: orphanProcesses.length === 0 && residualPorts.length === 0
      ? 'PASS'
      : 'FAIL',
  };
  return {
    ...receiptUnsigned,
    receiptDigest: stableDigest(receiptUnsigned),
  };
}

function makeFreshness(plan, runId, evidenceDigests, now) {
  const nonce = randomBytes(16).toString('hex');
  const fact = attestFact({
    factId: `freshness@${runId}`,
    executionId: runId,
    planDigest: plan.planDigest,
    nonce,
    issuedAt: now,
    expiry: now + Math.min(plan.timeouts.total, 300000),
    evidenceDigests: evidenceDigests.map(item => ({
      source: item.source,
      digest: item.digest,
      matched: true,
    })),
    current: true,
    stale: false,
    forged: false,
  });
  const key = `${runId}\0${plan.planDigest}\0${nonce}`;
  FRESHNESS_LEDGER.set(key, 'issued');
  return { fact, key };
}

function finalizer({
  context,
  plan,
  raw,
  caseStatuses,
  network,
  resources,
  freshness,
  freshnessKey,
  teardown,
  now,
}) {
  const binding = context.commitResult.bindingManifest;
  const expectedCases = binding.bindings.map(item => item.caseId);
  const executed = new Set(raw.attemptedCases);
  const bindingReconciled = plan.bindingDigest === binding.bindingDigest &&
    exactSet(expectedCases, plan.testSelection.caseIds);
  const rawValid =
    stableDigest(unsigned(raw, 'rawDigest')) === raw.rawDigest &&
    stableDigest(raw.reporters) === raw.reporterDigest;
  const teardownValid =
    stableDigest(unsigned(teardown, 'receiptDigest')) === teardown.receiptDigest;
  const networkValid = factValid(network, {
    planDigest: plan.planDigest,
    runId: raw.runId,
  }) &&
    network.hasEscape === network.entries.some(item => !item.allowed) &&
    network.entries.every(item => {
      const derived = targetAllowed(item.originalTarget, plan.allowlist);
      return derived.normalizedTarget === item.normalizedTarget &&
        derived.allowed === item.allowed &&
        derived.reason === item.reason;
    });
  const resourcesValid = factValid(resources, {
    planDigest: plan.planDigest,
    runId: raw.runId,
  }) &&
    resources.budget.cpu === plan.resources.cpu &&
    resources.budget.memMB === plan.resources.memMB &&
    resources.withinBudget ===
      (resources.usage.cpuPeak <= resources.budget.cpu &&
        resources.usage.memPeakMB <= resources.budget.memMB);
  const freshnessAttested = factValid(freshness, {
    executionId: raw.runId,
    planDigest: plan.planDigest,
  });
  const expectedEvidence = new Map([
    ['raw', raw.rawDigest],
    ['network', network.selfDigest],
    ['resources', resources.selfDigest],
    ['teardown', teardown.receiptDigest],
    ['binding', plan.bindingDigest],
  ]);
  const freshnessEvidenceValid =
    freshness.evidenceDigests.length === expectedEvidence.size &&
    freshness.evidenceDigests.every(item =>
      item.matched &&
      expectedEvidence.get(item.source) === item.digest);
  const freshnessValid = freshnessAttested &&
    freshnessEvidenceValid &&
    FRESHNESS_LEDGER.get(freshnessKey) === 'issued' &&
    freshness.issuedAt <= now &&
    freshness.expiry > freshness.issuedAt &&
    now < freshness.expiry &&
    freshness.current && !freshness.stale && !freshness.forged;
  if (FRESHNESS_LEDGER.get(freshnessKey) === 'issued') {
    FRESHNESS_LEDGER.set(freshnessKey, 'consumed');
  }
  const caseReconciliation = expectedCases.map(caseId => ({
    caseId,
    bound: true,
    executed: executed.has(caseId),
    status: executed.has(caseId) ? caseStatuses.get(caseId) : 'blocked',
  }));
  const success = raw.exitCode === 0 &&
    rawValid &&
    raw.reporters.length === 3 &&
    raw.summary.run > 0 &&
    raw.summary.run === expectedCases.length &&
    raw.summary.pass === expectedCases.length &&
    raw.summary.fail === 0 &&
    raw.summary.skip === 0 &&
    raw.producedReports === 3 &&
    raw.traces.length > 0 &&
    exactSet(expectedCases, raw.attemptedCases) &&
    expectedCases.every(caseId => caseStatuses.get(caseId) === 'pass') &&
    bindingReconciled &&
    teardownValid &&
    teardown.cleanupStatus === 'PASS' &&
    networkValid &&
    !network.hasEscape &&
    resourcesValid &&
    resources.withinBudget &&
    freshnessValid;
  const scopeChainDigest = stableDigest({
    planDigest: plan.planDigest,
    bindingDigest: binding.bindingDigest,
    profileDigest: plan.profileDigest,
    runId: raw.runId,
  });
  const resultUnsigned = {
    resultId: `canonical@${raw.runId}`,
    planDigest: plan.planDigest,
    bindingDigest: binding.bindingDigest,
    profileDigest: plan.profileDigest,
    status: success ? 'SUCCEEDED' : 'FAILED',
    recomputeBasis: {
      reporterDigest: raw.reporterDigest,
      rawDigest: raw.rawDigest,
      exitCode: raw.exitCode,
      bindingReconciled,
      caseCoverage: { ...raw.summary },
      teardownReceiptDigest: teardown.receiptDigest,
      networkAuditFactDigest: network.selfDigest,
      resourceExecutionFactDigest: resources.selfDigest,
      freshnessFactDigest: freshness.selfDigest,
      scopeChainDigest,
    },
    testsRun: raw.summary.run,
    pass: raw.summary.pass,
    fail: raw.summary.fail,
    skip: raw.summary.skip,
    caseReconciliation,
    claimScope: binding.claimScope,
    writer: 'finalizer',
  };
  return {
    ...resultUnsigned,
    resultDigest: stableDigest(resultUnsigned),
  };
}

export function createBrowserExecutionController(options = {}) {
  const {
    projectRoot,
    authoritySecret,
    keyId,
    clock = () => Date.now(),
    runner = spawnSync,
    readinessProbe,
    networkObserver,
    resourceObserver,
    teardownInspector,
    secretResolver = () => null,
    lifecycleAdapter = null,
  } = options;
  if (typeof projectRoot !== 'string' ||
      !(authoritySecret instanceof Uint8Array) ||
      authoritySecret.byteLength < 32 ||
      typeof keyId !== 'string' || keyId.length === 0 ||
      typeof clock !== 'function' ||
      typeof runner !== 'function' ||
      typeof readinessProbe !== 'function' ||
      typeof networkObserver !== 'function' ||
      typeof resourceObserver !== 'function' ||
      typeof teardownInspector !== 'function' ||
      typeof secretResolver !== 'function' ||
      (lifecycleAdapter !== null &&
        (typeof lifecycleAdapter !== 'object' ||
          typeof lifecycleAdapter.start !== 'function' ||
          typeof lifecycleAdapter.stop !== 'function'))) {
    throw new TypeError(EXECUTION_FAILURE_CODES.M5_CONTROLLER_INVALID);
  }
  const root = realpathSync(projectRoot);
  const key = Buffer.from(authoritySecret);
  const records = new Map();

  function sign(value) {
    return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  }

  function issue(plan, { ttlMs = 300000 } = {}) {
    const context = TRUSTED_EXECUTION_PLANS.get(plan);
    const now = clock();
    if (!context ||
        realpathSync(context.root) !== root ||
        !Number.isInteger(ttlMs) || ttlMs <= 0 ||
        !Number.isFinite(now)) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_HANDLE_SCOPE_MISMATCH,
        ['plan/controller/ttl 作用域不一致'],
      );
    }
    const authorizationSecret = randomBytes(32).toString('hex');
    const runId = `run-${randomBytes(12).toString('hex')}`;
    const handle = deepFreeze({
      handleId: `execute-handle@${randomBytes(16).toString('hex')}`,
      secretDigest: rawDigest(Buffer.from(authorizationSecret)),
      oneTime: true,
      service: 'execute',
      subject: plan.bindingDigest,
      project: stableDigest({ root }),
      plan: plan.planDigest,
      writeSetDigest: stableDigest(writeSetForRun(runId)),
      run: runId,
      expiry: now + ttlMs,
    });
    if (!schemaValid(context.context.pluginRoot, 'one-time-handle.json', handle)) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_HANDLE_INVALID,
        ['OneTimeHandle schema 无效'],
      );
    }
    records.set(handle.handleId, {
      handle,
      plan,
      secretDigest: handle.secretDigest,
      handleDigest: stableDigest(handle),
      privateMac: sign(handle),
      status: 'issued',
    });
    return {
      ok: true,
      status: 'HANDLE_ISSUED',
      code: 'EXECUTION_HANDLE_ISSUED',
      handle,
      authorizationSecret,
    };
  }

  function verify(record, handle, secret, plan) {
    if (!record ||
        !schemaValid(
          TRUSTED_EXECUTION_PLANS.get(plan)?.context.pluginRoot,
          'one-time-handle.json',
          handle,
        ) ||
        stableDigest(handle) !== record.handleDigest ||
        sign(handle) !== record.privateMac) {
      return EXECUTION_FAILURE_CODES.M5_HANDLE_INVALID;
    }
    if (record.status !== 'issued') return EXECUTION_FAILURE_CODES.M5_HANDLE_REPLAYED;
    if (clock() >= handle.expiry) return EXECUTION_FAILURE_CODES.M5_HANDLE_EXPIRED;
    if (rawDigest(Buffer.from(secret || '')) !== record.secretDigest) {
      return EXECUTION_FAILURE_CODES.M5_HANDLE_SECRET_MISMATCH;
    }
    if (record.plan !== plan ||
        handle.service !== 'execute' ||
        handle.subject !== plan.bindingDigest ||
        handle.project !== stableDigest({ root }) ||
        handle.plan !== plan.planDigest ||
        handle.writeSetDigest !== stableDigest(writeSetForRun(handle.run))) {
      return EXECUTION_FAILURE_CODES.M5_HANDLE_SCOPE_MISMATCH;
    }
    return null;
  }

  function execute({ plan, handle, authorizationSecret } = {}) {
    const context = TRUSTED_EXECUTION_PLANS.get(plan);
    const record = handle && records.get(handle.handleId);
    if (!context || realpathSync(context.root) !== root) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_HANDLE_SCOPE_MISMATCH,
        ['ExecutionPlan 不属于当前 controller'],
      );
    }
    const handleFailure = verify(record, handle, authorizationSecret, plan);
    if (handleFailure) return failure(handleFailure, [handleFailure]);
    record.status = 'reserved';
    if (!currentBindingValid(root, context)) {
      record.status = 'issued';
      return failure(
        EXECUTION_FAILURE_CODES.M5_BINDING_STALE,
        ['ProjectProfile、规格输入或生成测试字节已漂移'],
      );
    }
    const executable = localPlaywright(root);
    if (!executable) {
      record.status = 'issued';
      return failure(
        EXECUTION_FAILURE_CODES.M5_PREFLIGHT_BLOCKED,
        ['本地 Playwright 不存在；禁止自动安装'],
      );
    }
    if (plan.startCommand && !lifecycleAdapter) {
      record.status = 'issued';
      return failure(
        EXECUTION_FAILURE_CODES.M5_LIFECYCLE_ADAPTER_FAILED,
        ['ExecutionPlan 含 startCommand，但宿主未提供受信任 lifecycle adapter'],
      );
    }
    const secretEnv = {};
    for (const mapping of plan.secretHandles) {
      const [envName, handleRef] = mapping.split('=');
      let value;
      try {
        value = secretResolver(handleRef);
      } catch {
        value = null;
      }
      if (typeof value !== 'string') {
        record.status = 'issued';
        return failure(
          EXECUTION_FAILURE_CODES.M5_PLAN_SECRET_INVALID,
          [`secret handle 无法解析:${envName}`],
        );
      }
      secretEnv[envName] = value;
    }
    const runId = handle.run;
    const output = safeOutputRoot(root, runId);
    if (!output) {
      record.status = 'issued';
      return failure(
        EXECUTION_FAILURE_CODES.M5_PREFLIGHT_BLOCKED,
        ['隔离 output root 不安全'],
      );
    }
    const refs = reporterPaths(output);
    const env = {
      PATH: process.env.PATH || '',
      CI: '1',
      NO_COLOR: '1',
      PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(root, refs.json),
      PLAYWRIGHT_JUNIT_OUTPUT_NAME: resolve(root, refs.junit),
      PLAYWRIGHT_BLOB_OUTPUT_FILE: resolve(root, refs.blob),
      ...Object.fromEntries(plan.envWhitelist
        .filter(name => typeof process.env[name] === 'string')
        .map(name => [name, process.env[name]])),
      ...secretEnv,
    };
    let lifecycle = null;
    if (plan.startCommand) {
      record.status = 'consumed';
      try {
        lifecycle = lifecycleAdapter.start({
          command: plan.startCommand,
          cwd: root,
          env,
        });
      } catch {
        let teardown = null;
        try {
          teardown = makeTeardown(plan, teardownInspector({
            plan,
            runId,
            run: null,
            outputRoot: output.path,
            lifecycle: null,
            phase: 'lifecycle-start-failed',
          }));
        } catch {
          teardown = null;
        }
        if (!teardown) {
          return failure(
            EXECUTION_FAILURE_CODES.M5_TEARDOWN_INSPECTOR_FAILED,
            ['lifecycle start 异常后无法证明无残留'],
            { outputRoot: output.ref },
          );
        }
        return failure(
          EXECUTION_FAILURE_CODES.M5_LIFECYCLE_ADAPTER_FAILED,
          ['lifecycle start 异常'],
          { teardown, outputRoot: output.ref },
        );
      }
      if (!lifecycle || typeof lifecycle !== 'object') {
        let teardown = null;
        try {
          teardown = makeTeardown(plan, teardownInspector({
            plan,
            runId,
            run: null,
            outputRoot: output.path,
            lifecycle: null,
            phase: 'lifecycle-start-invalid',
          }));
        } catch {
          teardown = null;
        }
        if (!teardown) {
          return failure(
            EXECUTION_FAILURE_CODES.M5_TEARDOWN_INSPECTOR_FAILED,
            ['lifecycle start 返回畸形状态后无法证明无残留'],
            { outputRoot: output.ref },
          );
        }
        return failure(
          EXECUTION_FAILURE_CODES.M5_LIFECYCLE_ADAPTER_FAILED,
          ['lifecycle start 未返回宿主状态'],
          { teardown, outputRoot: output.ref },
        );
      }
    }
    let readiness;
    try {
      readiness = readinessProbe(plan.readiness, { lifecycle });
    } catch {
      readiness = null;
    }
    if (!readiness || readiness.status !== plan.readiness.expectedStatus) {
      let stopFailed = false;
      if (lifecycle) {
        try {
          lifecycleAdapter.stop({ lifecycle, plan });
        } catch {
          stopFailed = true;
        }
      }
      let observed = null;
      try {
        observed = teardownInspector({
          plan,
          runId,
          run: null,
          outputRoot: output.path,
          lifecycle,
          phase: 'readiness-failed',
        });
      } catch {
        observed = null;
      }
      const teardown = makeTeardown(plan, observed);
      if (!lifecycle) record.status = 'issued';
      if (!teardown) {
        return failure(
          EXECUTION_FAILURE_CODES.M5_TEARDOWN_INSPECTOR_FAILED,
          ['readiness 失败后无法证明无残留'],
          { outputRoot: output.ref },
        );
      }
      return failure(
        stopFailed
          ? EXECUTION_FAILURE_CODES.M5_LIFECYCLE_ADAPTER_FAILED
          : EXECUTION_FAILURE_CODES.M5_READINESS_BLOCKED,
        [stopFailed ? 'lifecycle stop 异常' : 'readiness 未达到冻结状态'],
        {
          teardown,
          outputRoot: output.ref,
        },
      );
    }
    let run;
    let runtime = null;
    try {
      record.status = 'consumed';
      runtime = writeRuntimeConfig(root, output, plan);
      const filterCount = plan.testSelection.fileGlobs.length;
      const commandOptions = plan.command.args.slice(0, -filterCount);
      const exactFilters = plan.command.args.slice(-filterCount);
      const runArgs = [
        ...commandOptions,
        '--config',
        runtime.configPath,
        '--output',
        runtime.artifactPath,
        ...exactFilters,
      ];
      run = runner(executable, runArgs, {
        cwd: root,
        env,
        encoding: 'utf8',
        shell: false,
        timeout: plan.timeouts.total,
        maxBuffer: 8 * 1024 * 1024,
      }, {
        outputRoot: output.path,
        reporterRefs: refs,
        artifactRoot: runtime.artifactPath,
        runtimeConfig: runtime.configPath,
        runId,
      });
    } catch (error) {
      run = {
        status: -1,
        stdout: '',
        stderr: '',
        errorCode: error?.code || 'RUNNER_THROW',
      };
    }
    if (run?.error && !run.errorCode) {
      run.errorCode = run.error.code || 'RUNNER_ERROR';
    }
    const parsed = parseReport(root, refs);
    let observations;
    try {
      observations = networkObserver({ plan, runId, run, outputRoot: output.path });
    } catch {
      observations = null;
    }
    let resourceObservation;
    try {
      resourceObservation = resourceObserver({
        plan,
        runId,
        run,
        outputRoot: output.path,
      });
    } catch {
      resourceObservation = null;
    }
    let lifecycleStopFailed = false;
    if (lifecycle) {
      try {
        lifecycleAdapter.stop({ lifecycle, plan, run });
      } catch {
        lifecycleStopFailed = true;
      }
    }
    let teardownObserved;
    try {
      teardownObserved = teardownInspector({
        plan,
        runId,
        run,
        outputRoot: output.path,
        lifecycle,
      });
    } catch {
      teardownObserved = null;
    }
    const teardown = makeTeardown(plan, teardownObserved);
    if (!teardown) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_TEARDOWN_INSPECTOR_FAILED,
        ['teardown inspector 未返回有效的进程/端口观测'],
      );
    }
    const failureEvidence = { teardown, outputRoot: output.ref };
    if (lifecycleStopFailed) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_LIFECYCLE_ADAPTER_FAILED,
        ['lifecycle stop 异常'],
        failureEvidence,
      );
    }
    if (run.errorCode) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_RUNNER_FAILED,
        [`runner 异常:${run.errorCode}`],
        failureEvidence,
      );
    }
    if (!parsed.ok) {
      return failure(
        parsed.code,
        [parsed.kind || parsed.code],
        failureEvidence,
      );
    }
    if (!Array.isArray(observations) ||
        observations.some(item =>
          !item || typeof item.url !== 'string' ||
          (item.hop !== undefined && !Number.isInteger(item.hop)))) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_NETWORK_OBSERVER_FAILED,
        ['network observer 未返回原始 URL 观测'],
        failureEvidence,
      );
    }
    const resources = makeResourceFact(plan, runId, resourceObservation);
    if (!resources) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_RESOURCE_OBSERVER_FAILED,
        ['resource observer 未返回可验证的峰值事实'],
        failureEvidence,
      );
    }
    const artifacts = collectArtifactFiles(root, runtime.artifacts);
    if (!artifacts.ok) {
      return failure(
        EXECUTION_FAILURE_CODES.M5_REPORTER_INVALID,
        ['Playwright artifact root 无法安全读取'],
        failureEvidence,
      );
    }
    const caseStatuses = new Map();
    let caseMappingInvalid = false;
    for (const spec of parsed.specs) {
      const matches = plan.testSelection.caseIds
        .filter(caseId => spec.title.includes(caseId));
      if (matches.length !== 1 || caseStatuses.has(matches[0])) {
        caseMappingInvalid = true;
        continue;
      }
      caseStatuses.set(matches[0], spec.status);
    }
    const attemptedCases = caseMappingInvalid ? [] : [...caseStatuses.keys()];
    const rawUnsigned = {
      planDigest: plan.planDigest,
      runId,
      reporters: parsed.reporters,
      summary: parsed.summary,
      exitCode: Number.isInteger(run.status) ? run.status : -1,
      traces: artifacts.traces,
      screenshots: artifacts.screenshots,
      attemptedCases,
      producedReports: parsed.reporters.length,
      reporterDigest: stableDigest(parsed.reporters),
    };
    const raw = {
      ...rawUnsigned,
      rawDigest: stableDigest(rawUnsigned),
    };
    const network = makeNetworkFact(plan, runId, observations);
    const factNow = clock();
    const freshnessBundle = makeFreshness(plan, runId, [
      { source: 'raw', digest: raw.rawDigest },
      { source: 'network', digest: network.selfDigest },
      { source: 'resources', digest: resources.selfDigest },
      { source: 'teardown', digest: teardown.receiptDigest },
      { source: 'binding', digest: plan.bindingDigest },
    ], factNow);
    const finalizerNow = clock();
    const canonical = finalizer({
      context,
      plan,
      raw,
      caseStatuses,
      network,
      resources,
      freshness: freshnessBundle.fact,
      freshnessKey: freshnessBundle.key,
      teardown,
      now: finalizerNow,
    });
    for (const [schema, value] of [
      ['raw-execution-result.json', raw],
      ['network-audit-fact.json', network],
      ['resource-execution-fact.json', resources],
      ['freshness-fact.json', freshnessBundle.fact],
      ['teardown-receipt.json', teardown],
      ['canonical-result.json', canonical],
    ]) {
      const validation = validateSchema(context.context.pluginRoot, schema, value);
      if (!validation.valid) {
        return failure(
          EXECUTION_FAILURE_CODES.M5_RESULT_SCHEMA_INVALID,
          [
            `schema 无效:${schema}`,
            ...validation.errors.map(item =>
              `${item.instancePath || '/'}:${item.message}`),
          ],
        );
      }
    }
    return deepFreeze({
      ok: true,
      status: canonical.status,
      code: canonical.status === 'SUCCEEDED'
        ? 'EXECUTION_SUCCEEDED'
        : 'EXECUTION_FAILED',
      planDigest: plan.planDigest,
      raw,
      networkAudit: network,
      resourceExecution: resources,
      teardown,
      freshness: freshnessBundle.fact,
      canonical,
      outputRoot: output.ref,
    });
  }

  return Object.freeze({ issue, execute });
}
