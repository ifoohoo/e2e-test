#!/usr/bin/env node

/**
 * 已安装候选包的 Codex / Claude Code 双宿主行为资格验证器。
 *
 * 宿主只负责读取其 adapter 中的技能协议，并执行一个确定性场景脚本。
 * 资格结论由本进程依据事件流、场景 schema/语义、安装树与项目写集独立计算；
 * 宿主的自然语言或最终 JSON 回执不能单独构成通过证据。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClaudeSecuritySettings, buildQualificationSubject, classifyHost, containsAbsolutePath, createValidators, digestBytes,
  expectedProjectFiles, formatAjvErrors, qualificationErrorCode,
  finalizeQualificationEvidence,
  parseClaudeEvents, parseCodexEvents, projectFiles, snapshotTree, stableDigest,
  qualificationStatus, validateCrossHostIdentity, validateScenario, validateScenarioIdentity,
  validateToolTrace,
} from './lib/behavior-qualification.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const finalizeMode = args.includes('--finalize');
const schemaRoot = join(pluginRoot, 'schemas');
const validators = createValidators(schemaRoot);
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const REQUIRED_ENV = ['E2E_TEST_REGISTRY_ROOT', 'E2E_TEST_ARTIFACT_GRAPH_ROOT', 'E2E_TEST_ASSISTANT_ROOT'];
const HOST_TIMEOUT_MS = Number(process.env.E2E_TEST_HOST_TIMEOUT_MS ?? 360000);

let tempRoot;
try {
  for (const name of REQUIRED_ENV) {
    if (!process.env[name] || !isAbsolute(process.env[name])) throw new Error(`${name}_REQUIRED_ABSOLUTE`);
  }
  if (!Number.isFinite(HOST_TIMEOUT_MS) || HOST_TIMEOUT_MS < 1000 || HOST_TIMEOUT_MS > 900000) {
    throw new Error('HOST_TIMEOUT_INVALID');
  }
  tempRoot = mkdtempSync(join(tmpdir(), 'e2e-behavior-qualification-'));
  const result = runQualification();
  if (finalizeMode) finalizeQualificationEvidence({ pluginRoot, result, validateResult: validators.result });
  emit(result);
  process.exit(result.qualificationStatus === 'QUALIFIED' ? 0 : 1);
} catch (error) {
  const blocked = {
    schemaVersion: 1,
    qualificationStatus: 'BLOCKED',
    code: qualificationErrorCode(error),
  };
  process.stdout.write(`${JSON.stringify(blocked, null, jsonMode ? 2 : 0)}\n`);
  process.exit(1);
} finally {
  if (tempRoot && existsSync(tempRoot)) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
}

function runQualification() {
  // 刷新事务中 adapter conformance 已先合法更新，而本轮 behavior
  // qualification 尚待 finalize；这里只核对生成内容，避免以旧资格证明
  // 阻断产生新资格证明。对外 build:check 不带此开关，仍严格检查三根证明。
  execFileSync(process.execPath, [
    join(pluginRoot, 'scripts', 'build-adapters.mjs'),
    '--check',
    '--skip-proof-check',
  ], {
    cwd: pluginRoot, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const packRoot = join(tempRoot, 'packs');
  mkdirSync(packRoot, { recursive: true });
  const packages = [
    packCandidate('agent-method-registry', resolvePackageDir(process.env.E2E_TEST_REGISTRY_ROOT, 'agent-method-registry'), packRoot),
    packCandidate('artifact-graph', resolvePackageDir(process.env.E2E_TEST_ARTIFACT_GRAPH_ROOT, 'artifact-graph'), packRoot),
    packCandidate('artifact-chain-assistant', resolvePackageDir(process.env.E2E_TEST_ASSISTANT_ROOT, 'artifact-chain-assistant'), packRoot),
    packCandidate('e2e-test', pluginRoot, packRoot),
  ];

  const consumerRoot = join(tempRoot, 'consumer');
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'e2e-behavior-qualification-consumer', version: '1.0.0', private: true, type: 'module',
    dependencies: Object.fromEntries(packages.map(pkg => [pkg.name, `file:${pkg.tarball}`])),
  }, null, 2)}\n`);
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumerRoot, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const pkg of packages) {
    const installed = JSON.parse(readFileSync(join(consumerRoot, 'node_modules', pkg.name, 'package.json'), 'utf8'));
    if (installed.name !== pkg.name || installed.version !== pkg.version) throw new Error(`INSTALLED_IDENTITY_MISMATCH:${pkg.name}`);
  }

  const installed = {
    registry: realpathSync(join(consumerRoot, 'node_modules', 'agent-method-registry')),
    artifactGraph: realpathSync(join(consumerRoot, 'node_modules', 'artifact-graph')),
    assistant: realpathSync(join(consumerRoot, 'node_modules', 'artifact-chain-assistant')),
    e2e: realpathSync(join(consumerRoot, 'node_modules', 'e2e-test')),
  };
  const artifactGraphCommand = join(installed.artifactGraph, 'dist', 'cli.js');
  for (const path of [artifactGraphCommand, join(installed.registry, 'dist', 'cli.js')]) {
    if (!existsSync(path)) throw new Error(`INSTALLED_COMMAND_MISSING:${basename(path)}`);
  }
  verifyAdapterBundle(installed.e2e);

  const e2eTarballDigest = packages.find(pkg => pkg.name === 'e2e-test').tarballDigest;
  const qualificationSubjects = {
    root: buildQualificationSubject(installed.e2e),
    codex: buildQualificationSubject(join(installed.e2e, 'adapters', 'codex')),
    claude: buildQualificationSubject(join(installed.e2e, 'adapters', 'claude')),
  };
  const descriptor = readFileSync(join(installed.e2e, 'family', 'implementation.yaml'), 'utf8');
  const authority = JSON.parse(readFileSync(join(installed.e2e, 'authority-api', 'api.json'), 'utf8'));
  const contract = explainContract(artifactGraphCommand);

  const codex = qualifyHost({
    host: 'codex', command: process.env.E2E_TEST_CODEX_COMMAND ?? 'codex',
    adapterRoot: join(installed.e2e, 'adapters', 'codex'), adapterLoadMode: 'skill-md-explicit',
    consumerRoot, installed, artifactGraphCommand, e2eTarballDigest,
    qualificationSubject: qualificationSubjects.codex,
    familyApiRevision: authority.api.revisionDigest, contractRevision: contract,
  });
  const claude = qualifyHost({
    host: 'claude-code', command: process.env.E2E_TEST_CLAUDE_COMMAND ?? 'claude',
    adapterRoot: join(installed.e2e, 'adapters', 'claude'), adapterLoadMode: 'plugin-dir',
    consumerRoot, installed, artifactGraphCommand, e2eTarballDigest,
    qualificationSubject: qualificationSubjects.claude,
    familyApiRevision: authority.api.revisionDigest, contractRevision: contract,
  });

  const trials = [...(codex.scenario?.checks ?? []), ...(claude.scenario?.checks ?? [])];
  const hosts = { codex: codex.result, claude: claude.result };
  const crossHostIdentity = validateCrossHostIdentity(codex.scenario?.identity, claude.scenario?.identity);
  const aggregateStatus = qualificationStatus(hosts, trials.length, crossHostIdentity.valid);
  const unsigned = {
    schemaVersion: 1,
    qualificationKind: 'operationalQualification',
    qualificationStatus: aggregateStatus,
    hosts,
    trials,
    evidence: {
      packages: packages.map(({ name, version, tarballDigest }) => ({ name, version, tarballDigest })),
      qualificationSubjects,
      familyApiRevision: authority.api.revisionDigest,
      contractRevision: contract,
      bundleDigest: yamlScalar(descriptor, 'treeDigest'),
      deterministicAttestation: yamlScalar(descriptor, 'deterministicAttestation'),
      scenarioIdentities: {
        codex: codex.scenario?.identity ?? null,
        claude: claude.scenario?.identity ?? null,
      },
    },
  };
  const result = { ...unsigned, digest: stableDigest(unsigned) };
  if (!validators.result(result)) throw new Error(`RESULT_SCHEMA_INVALID:${formatAjvErrors(validators.result.errors)}`);
  if (containsAbsolutePath(result)) throw new Error('RESULT_PATH_LEAK');
  return result;
}

function qualifyHost({
  host, command, adapterRoot, adapterLoadMode, consumerRoot, installed,
  artifactGraphCommand, e2eTarballDigest, qualificationSubject, familyApiRevision, contractRevision,
}) {
  const fallback = {
    hostId: host, cliVersion: 'unavailable', status: 'HOST_UNAVAILABLE', adapterLoadMode,
    skillReadsVerified: false, businessCommandsVerified: false, scenarioCommandVerified: false, packageUnmodified: false,
    unexpectedToolsDetected: false,
    inputsUnmodified: false, unauthorizedWriteDetected: false, absolutePathDetected: false,
    scenarioDigest: ZERO_DIGEST, toolEventsDigest: ZERO_DIGEST,
  };
  let cliVersion;
  try {
    cliVersion = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return { result: fallback, scenario: null };
  }

  const prepareScript = join(adapterRoot, 'scripts', 'behavior-qualification-prepare.mjs');
  const verifyScript = join(adapterRoot, 'scripts', 'behavior-qualification-verify.mjs');
  const trialsScript = join(adapterRoot, 'scripts', 'behavior-qualification-trials.mjs');
  const serviceRunner = join(adapterRoot, 'scripts', 'service-runner.mjs');
  const skillPaths = ['e2e-test', 'e2e-test-help', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair']
    .map(name => join(adapterRoot, 'skills', name, 'SKILL.md'));
  const receiptSchemaPath = join(adapterRoot, 'schemas', 'behavior-host-receipt.json');
  for (const path of [adapterRoot, prepareScript, verifyScript, trialsScript, serviceRunner, receiptSchemaPath, ...skillPaths]) {
    if (!existsSync(path)) return { result: { ...fallback, cliVersion, status: 'SCENARIO_INVALID' }, scenario: null };
  }
  verifyAdapterBundle(adapterRoot);

  const projectRoot = join(tempRoot, `project-${host}`);
  mkdirSync(projectRoot, { recursive: true });
  const outputRelative = `qualification-results/${host}.json`;
  execFileSync(process.execPath, [
    prepareScript, '--host', host, '--project-root', projectRoot,
    '--qualification-input-tarball-digest', e2eTarballDigest,
    '--qualification-subject-digest', qualificationSubject.digest,
    '--artifact-graph-command', artifactGraphCommand,
  ], {
    cwd: adapterRoot, encoding: 'utf8', timeout: 30000,
    env: installedEnvironment(installed, artifactGraphCommand), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const protectedBefore = protectedDigest(projectRoot);
  const exactReadCommand = `sed -n '1,260p' ${skillPaths.map(shellQuote).join(' ')}`;
  const exactBusinessCommand = buildBusinessCommand({ projectRoot, trialsScript, serviceRunner, artifactGraphCommand });
  const verifyArgs = ['--host', host, '--project-root', projectRoot, '--output', outputRelative];
  const exactVerifyCommand = `${shellQuote(process.execPath)} ${shellQuote(verifyScript)} ${verifyArgs.map(shellQuote).join(' ')}`;
  const prompt = buildPrompt({ host, skillPaths, exactReadCommand, exactBusinessCommand, exactVerifyCommand, outputRelative });
  const receiptSchema = readFileSync(receiptSchemaPath, 'utf8').trim();
  const env = installedEnvironment(installed, artifactGraphCommand);
  const claudeSettings = buildClaudeSecuritySettings({
    projectRoot, adapterRoot, consumerRoot, skillPaths,
    exactReadCommand, exactBusinessCommand, exactVerifyCommand,
    environment: env,
  });
  const hostArgs = host === 'codex'
    ? ['exec', '--json', '--output-schema', receiptSchemaPath, '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', projectRoot, '--add-dir', adapterRoot, prompt]
    : [
      '-p', '--output-format', 'stream-json', '--json-schema', receiptSchema,
      '--plugin-dir', adapterRoot, '--tools', 'Read,Bash', '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read', 'Bash', ...claudeSettings.permissions.allow,
      '--disallowedTools', ...claudeSettings.permissions.deny,
      // claude-code 2.1.220 起认证凭据随 user setting 源加载；排除 user 源会导致 Not logged in。
      // 权限边界仍由显式 --settings/--allowedTools/--disallowedTools 控制（deny 优先，覆盖 user 级 allow）。
      '--setting-sources', 'user', '--settings', JSON.stringify(claudeSettings), '--verbose',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', prompt,
    ];

  const consumerBefore = snapshotTree(consumerRoot);
  const invocation = spawnSync(command, hostArgs, {
    cwd: projectRoot, env, encoding: 'utf8', timeout: HOST_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const consumerAfter = snapshotTree(consumerRoot);
  const packageUnmodified = consumerBefore.digest === consumerAfter.digest;
  const projectSnapshot = snapshotTree(projectRoot);
  const inputsUnmodified = protectedBefore === protectedDigest(projectRoot);
  const actualProjectFiles = projectFiles(projectSnapshot);
  const unauthorizedWriteDetected = JSON.stringify(actualProjectFiles) !== JSON.stringify(expectedProjectFiles(host));

  let parsed;
  try {
    parsed = host === 'codex' ? parseCodexEvents(invocation.stdout) : parseClaudeEvents(invocation.stdout);
  } catch {
    return { result: { ...fallback, cliVersion, status: invocation.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'EVENT_STREAM_INVALID', packageUnmodified, unauthorizedWriteDetected }, scenario: null };
  }
  const trace = validateToolTrace({
    tools: parsed.tools, skillPaths,
    expectedReadCommand: exactReadCommand,
    expectedBusinessCommand: exactBusinessCommand,
    expectedVerifyCommand: exactVerifyCommand,
  });
  const outputPath = join(projectRoot, outputRelative);
  let scenario = null;
  let scenarioValidation = { valid: false };
  if (existsSync(outputPath)) {
    try {
      scenario = JSON.parse(readFileSync(outputPath, 'utf8'));
      scenarioValidation = validateScenario(scenario, host, validators.scenario);
      const adapterDescriptor = readFileSync(join(adapterRoot, 'family', 'implementation.yaml'), 'utf8');
      const adapterPackage = JSON.parse(readFileSync(join(adapterRoot, 'package.json'), 'utf8'));
      const identityValidation = validateScenarioIdentity(scenario.identity, {
        familyApiRevision,
        contractRevision,
        implementationId: yamlTextScalar(adapterDescriptor, 'familyImplementationId'),
        implementationVersion: adapterPackage.version,
        qualificationInputTarballDigest: e2eTarballDigest,
        qualificationSubjectDigest: qualificationSubject.digest,
        bundleDigest: yamlScalar(adapterDescriptor, 'treeDigest'),
        deterministicAttestation: yamlScalar(adapterDescriptor, 'deterministicAttestation'),
      });
      scenarioValidation = {
        valid: scenarioValidation.valid && identityValidation.valid,
        errors: [...(scenarioValidation.errors ?? []), ...identityValidation.errors],
      };
    } catch {}
  }
  const receiptValid = validators.receipt(parsed.receipt) && parsed.receipt.host === host &&
    parsed.receipt.scenarioResult === outputRelative && parsed.receipt.scenarioDigest === scenario?.digest;
  const absolutePathDetected = containsAbsolutePath(scenario) || containsAbsolutePath(parsed.receipt);

  const status = classifyHost({
    timedOut: invocation.error?.code === 'ETIMEDOUT',
    exitCode: invocation.status,
    trace,
    receiptValid,
    scenarioValid: scenarioValidation.valid,
    packageUnmodified,
    inputsUnmodified,
    unauthorizedWriteDetected,
    absolutePathDetected,
  });

  return {
    result: {
      hostId: host, cliVersion, status, adapterLoadMode,
      skillReadsVerified: trace.skillReadsVerified,
      businessCommandsVerified: trace.businessCommandsVerified,
      scenarioCommandVerified: trace.scenarioCommandVerified,
      unexpectedToolsDetected: trace.unexpectedToolsDetected,
      packageUnmodified,
      inputsUnmodified,
      unauthorizedWriteDetected,
      absolutePathDetected,
      scenarioDigest: scenario?.digest ?? ZERO_DIGEST,
      toolEventsDigest: trace.toolEventsDigest,
    },
    scenario,
  };
}

function buildPrompt({ host, skillPaths, exactReadCommand, exactBusinessCommand, exactVerifyCommand, outputRelative }) {
  return [
    '这是已安装候选包的行为资格验证，不是开发任务。不要修改插件、技能或配置。',
    '必须严格按顺序完成：',
    `1. 读取以下五个 SKILL.md，且必须读取这些精确的已安装路径：\n${skillPaths.map(path => `- ${path}`).join('\n')}\nCodex 必须逐字执行这一条读取命令；Claude Code 可以改用五次精确路径的 Read 工具：\n${exactReadCommand}`,
    `2. 全部读取完成后，逐字执行下面这条业务命令。它直接调用 14 次 service-runner；不得改写、拆分或替换：\n${exactBusinessCommand}`,
    `3. 业务命令成功后，逐字执行下面这条只读资格汇总命令：\n${exactVerifyCommand}`,
    `4. 根据汇总命令输出返回严格 JSON：{"status":"HOST_SCENARIO_COMPLETE","host":"${host}","scenarioResult":"${outputRelative}","scenarioDigest":"<命令输出中的 sha256 摘要>"}`,
    '不得执行 git 命令，不得编辑文件，不得运行其他业务命令。',
  ].join('\n\n');
}

function buildBusinessCommand({ projectRoot, trialsScript, serviceRunner, artifactGraphCommand }) {
  return [
    shellQuote(process.execPath), shellQuote(trialsScript),
    '--project-root', shellQuote(projectRoot),
    '--service-runner', shellQuote(serviceRunner),
    '--artifact-graph-command', shellQuote(artifactGraphCommand),
  ].join(' ');
}

function installedEnvironment(installed, artifactGraphCommand) {
  const exact = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]);
  const prefix = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|VERTEX|XDG)_/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => exact.has(key) || prefix.test(key)));
  return {
    ...env,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    E2E_TEST_REGISTRY_ROOT: installed.registry,
    E2E_TEST_ARTIFACT_GRAPH_ROOT: installed.artifactGraph,
    E2E_TEST_ASSISTANT_ROOT: installed.assistant,
    E2E_TEST_ARTIFACT_GRAPH_COMMAND: artifactGraphCommand,
  };
}

function protectedDigest(projectRoot) {
  const prepared = JSON.parse(readFileSync(join(projectRoot, 'qualification-control', 'prepared.json'), 'utf8'));
  return stableDigest(prepared.protectedFiles.map(item => {
    const path = resolve(projectRoot, item.path);
    return { path: item.path, digest: existsSync(path) ? digestBytes(readFileSync(path)) : 'MISSING' };
  }));
}

function packCandidate(expectedName, packageDir, destination) {
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (packageJson.name !== expectedName) throw new Error(`PACKAGE_IDENTITY_MISMATCH:${expectedName}`);
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: packageDir, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const data = JSON.parse(output);
  if (!Array.isArray(data) || data.length !== 1) throw new Error(`PACK_RESULT_INVALID:${expectedName}`);
  const tarball = join(destination, data[0].filename);
  if (!existsSync(tarball)) throw new Error(`TARBALL_MISSING:${expectedName}`);
  return { name: expectedName, version: packageJson.version, tarball, tarballDigest: digestBytes(readFileSync(tarball)) };
}

function resolvePackageDir(root, expectedName) {
  const candidates = [
    resolve(root),
    join(resolve(root), 'packages', expectedName),
    join(resolve(root), 'plugins', expectedName),
  ];
  for (const candidate of candidates) {
    const manifest = join(candidate, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === expectedName) return candidate;
    } catch {}
  }
  throw new Error(`PACKAGE_ROOT_NOT_FOUND:${expectedName}`);
}

function verifyAdapterBundle(adapterRoot) {
  const script = join(adapterRoot, 'scripts', 'bundle-digest.mjs');
  const output = execFileSync(process.execPath, [script, '--verify', '--json'], {
    cwd: adapterRoot, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(output);
  if (result.ok !== true || result.code !== 'VERIFIED' || result.status !== 'VERIFIED') {
    throw new Error(`ADAPTER_BUNDLE_INVALID:${basename(adapterRoot)}`);
  }
}

function explainContract(command) {
  const output = execFileSync(process.execPath, [command, 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], {
    encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(output);
  if (result.ok !== true || !/^sha256:[a-f0-9]{64}$/.test(result.data?.identity?.revisionDigest ?? '')) {
    throw new Error('CONTRACT_EXPLAIN_INVALID');
  }
  return result.data.identity.revisionDigest;
}

function yamlScalar(text, key) {
  const value = text.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`DESCRIPTOR_DIGEST_INVALID:${key}`);
  return value;
}

function yamlTextScalar(text, key) {
  const value = text.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  if (!value || /[\\r\\n]/.test(value)) throw new Error(`DESCRIPTOR_FIELD_INVALID:${key}`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function emit(result) {
  if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.qualificationStatus}: ${result.digest}\n`);
}
