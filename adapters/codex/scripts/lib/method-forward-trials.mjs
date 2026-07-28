import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { containsAbsolutePath, snapshotTree, stableDigest } from './behavior-qualification.mjs';
import { signMethodForwardQualification } from './method-forward-qualification.mjs';

export const FORWARD_STAGES = [
  'inspect', 'assess', 'design', 'compose', 'review-core', 'repair-core', 'reconcile', 'validate',
];

export const FORWARD_PACKAGE_IDS = [
  'fwd-freight-customs', 'fwd-library-holds', 'fwd-ticket-escalation',
];

export const FORWARD_HOSTS = ['codex', 'claude-code'];

/**
 * Recovery-25 WP1：方法正向运行预算统一策略（trial-runner 与 reviewer 共享）。
 *
 * R24 真实宿主试验 claude-code--fwd-library-holds 在约 540 秒处被内部 timeout 截断
 * （run-receipt exit.kind=TIMEOUT, code=143）：事件流证明宿主仍在装载方法资源
 * （读完 author SKILL、五个 references、三个工序说明、项目 raw 输入与三个 Schema），
 * 尚未发起第一次 author 驱动调用，stderr 为空，输入与插件前后一致——属慢模型
 * （qwen3.8-max-preview）运行预算不足，而非产品逻辑失败。旧预算默认 600,000ms、
 * 上限 900,000ms 不足以覆盖慢模型八阶段作者链；此处统一提高到默认 1,200,000ms、
 * 上限 1,800,000ms，下限 1,000ms 保留（受控/合成短预算测试继续使用）。
 *
 * trial 与 reviewer 两个控制平面经 resolveForwardTimeoutMs 取得同构预算合同：
 * 同一默认值、同一上下限、同一失败关闭码 FORWARD_TIMEOUT_INVALID。
 *
 * 本 helper 不得复用到 scripts/behavior-qualification-harness.mjs 或
 * scripts/behavior-qualification-runner.mjs——那是另一套独立预算合同
 * （E2E_TEST_HOST_TIMEOUT_MS / HOST_TIMEOUT_INVALID），与本合同互不代换。
 */
export const FORWARD_TIMEOUT_DEFAULT_MS = 1200000;
export const FORWARD_TIMEOUT_MIN_MS = 1000;
export const FORWARD_TIMEOUT_MAX_MS = 1800000;
export const FORWARD_TIMEOUT_INVALID_CODE = 'FORWARD_TIMEOUT_INVALID';

/**
 * 解析方法正向运行预算（毫秒）及来源。trial-runner 与 reviewer 共同消费，策略一致。
 *
 * 优先级：CLI --timeout-ms（flagValue）> 环境变量（envValue）> 默认值
 * FORWARD_TIMEOUT_DEFAULT_MS，与历史 `flag || env || default` 语义逐字一致。
 *
 * 非法预算（非数值 NaN、超过上限 FORWARD_TIMEOUT_MAX_MS、低于下限
 * FORWARD_TIMEOUT_MIN_MS）确定性失败关闭：抛 FORWARD_TIMEOUT_INVALID，
 * 绝不静默回退默认值。
 *
 * R27 杠杆 3：返回 { timeoutMs, source } 以支持预算可观测。source 取值
 * 'cli' | 'env' | 'default'，记录实际生效预算的来源，供 run-receipt 与
 * trial-result 审计。
 *
 * @param {string|null|undefined} flagValue CLI --timeout-ms 原始值。
 * @param {string|undefined} envValue 环境变量覆盖原始值（E2E_TEST_FORWARD_TIMEOUT_MS）。
 * @returns {{ timeoutMs: number, source: 'cli'|'env'|'default' }} 合法运行预算与来源。
 */
export function resolveForwardBudget(flagValue, envValue) {
  const source = flagValue ? 'cli' : envValue ? 'env' : 'default';
  const raw = flagValue || envValue || FORWARD_TIMEOUT_DEFAULT_MS;
  const timeoutMs = Number(raw);
  if (!Number.isFinite(timeoutMs) || timeoutMs < FORWARD_TIMEOUT_MIN_MS || timeoutMs > FORWARD_TIMEOUT_MAX_MS) {
    throw coded(FORWARD_TIMEOUT_INVALID_CODE);
  }
  return { timeoutMs, source };
}

/**
 * 解析方法正向运行预算（毫秒）。向后兼容接口，reviewer 等既有调用方继续使用。
 * 内部委托 resolveForwardBudget，仅返回 timeoutMs 数值。
 *
 * @param {string|null|undefined} flagValue CLI --timeout-ms 原始值。
 * @param {string|undefined} envValue 环境变量覆盖原始值（E2E_TEST_FORWARD_TIMEOUT_MS）。
 * @returns {number} 合法运行预算（毫秒），可直接传给 spawnSync timeout。
 */
export function resolveForwardTimeoutMs(flagValue, envValue) {
  return resolveForwardBudget(flagValue, envValue).timeoutMs;
}

export function createForwardValidators(pluginRoot) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const compile = name => ajv.compile(JSON.parse(readFileSync(join(pluginRoot, 'schemas', name), 'utf8')));
  return {
    trial: compile('method-forward-trial-result.json'),
    packet: compile('forward-reviewer-packet.json'),
    rubric: compile('forward-trial-rubric.json'),
    qualification: compile('method-forward-qualification.json'),
    receipt: compile('method-forward-host-receipt.json'),
  };
}

export function trialId(hostId, packageId) {
  if (!FORWARD_HOSTS.includes(hostId) || !FORWARD_PACKAGE_IDS.includes(packageId)) throw coded('TRIAL_ID_INVALID');
  return `${hostId}--${packageId}`;
}

export function digestFile(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function digestTree(root) {
  return snapshotTree(root).digest;
}

export function safeRelative(root, candidate) {
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(canonicalRoot, candidate);
  const rel = relative(canonicalRoot, absolute).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw coded('PATH_ESCAPE');
  return { absolute, relative: rel };
}

export function listFiles(root) {
  if (!existsSync(root)) return [];
  const output = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).replaceAll('\\', '/'));
      else throw coded('UNSUPPORTED_FILE_TYPE');
    }
  };
  walk(root);
  return output;
}

export function verifyTrialResult(result, validateSchema) {
  const diagnostics = [];
  if (!validateSchema(result)) diagnostics.push('TRIAL_SCHEMA_INVALID');
  if (!verifySigned(result)) diagnostics.push('TRIAL_DIGEST_INVALID');
  if (result?.trialId !== `${result?.hostId}--${result?.packageId}`) diagnostics.push('TRIAL_IDENTITY_MISMATCH');
  const stages = result?.author?.stages ?? [];
  const chainComplete = result?.author?.chainCompleted === true &&
    JSON.stringify(stages) === JSON.stringify(FORWARD_STAGES) &&
    isDigest(result?.author?.stageChainDigest) && isDigest(result?.author?.previewDigest) &&
    result?.author?.plannedWrites?.length === 4;
  if (result?.status === 'PASS' && !chainComplete) diagnostics.push('TRIAL_AUTHOR_CHAIN_INCOMPLETE');
  const invocation = result?.invocation ?? {};
  if (result?.status === 'PASS' && (
    invocation.timedOut || invocation.exitCode !== 0 || !invocation.skillReadVerified ||
    !invocation.authorCommandVerified || invocation.unexpectedToolDetected
  )) diagnostics.push('TRIAL_INVOCATION_INVALID');
  const isolation = result?.isolation ?? {};
  if (result?.status === 'PASS' && (
    !isolation.inputUnmodified || !isolation.pluginUnmodified ||
    !isolation.zeroUnauthorizedWrites || isolation.absolutePathDetected
  )) diagnostics.push('TRIAL_ISOLATION_INVALID');
  if (containsAbsolutePath(result)) diagnostics.push('TRIAL_PATH_LEAK');
  return { valid: diagnostics.length === 0, diagnostics };
}

export function signTrialResult(unsigned) {
  return { ...unsigned, digest: stableDigest(unsigned) };
}

export function classifyForwardTrial(facts) {
  if (facts.hostUnavailable) return ['BLOCKED', 'HOST_UNAVAILABLE'];
  // R27 杠杆 2：看门狗强制杀进程（长时间无工具产出）优先于通用超时判定。
  if (facts.enforcedKill) return ['FAIL', 'NO_TOOL_OUTPUT_ENFORCED'];
  if (facts.timedOut) return ['FAIL', 'HOST_TIMEOUT'];
  if (!facts.eventStreamValid) return ['FAIL', 'EVENT_STREAM_INVALID'];
  if (!facts.skillReadVerified) return ['FAIL', 'SKILL_READ_MISSING'];
  // 隔离完整性优先于 receipt 语义：篡改输入/插件/写集/绝对路径泄漏先失败关闭。
  if (facts.inputMutated) return ['FAIL', 'INPUT_MUTATED'];
  if (facts.pluginMutated) return ['FAIL', 'PLUGIN_MUTATED'];
  if (facts.unauthorizedWriteDetected) return ['FAIL', 'UNAUTHORIZED_WRITE'];
  if (facts.absolutePathDetected) return ['FAIL', 'ABSOLUTE_PATH_LEAK'];
  if (facts.unexpectedToolDetected) return ['FAIL', 'UNEXPECTED_TOOL'];
  // receipt 诚实性：失败 receipt 与现场不一致，或成功 receipt 缺少真实 author-output，
  // 都在作者命令判定之前失败关闭，防止退出码或自报状态掩盖业务失败。
  if (facts.failureReceiptInconsistent || facts.successReceiptInconsistent) return ['FAIL', 'HOST_RECEIPT_INCONSISTENT'];
  // 诚实失败 receipt（驱动确有尝试且结构化失败，且无 author-output）是合法失败证据，
  // 记为 HOST_DRIVER_FAILED 而不是 AUTHOR_COMMAND_MISSING。
  if (facts.failureReceiptHonest) return ['FAIL', 'HOST_DRIVER_FAILED'];
  if (!facts.authorCommandVerified) return ['FAIL', 'AUTHOR_COMMAND_MISSING'];
  if (!facts.authorChainCompleted) return ['FAIL', 'AUTHOR_CHAIN_INCOMPLETE'];
  if (!facts.previewValid) return ['FAIL', 'PREVIEW_INVALID'];
  if (facts.exitCode !== 0) return ['FAIL', 'HOST_EXIT_NONZERO'];
  return ['PASS', 'TRIAL_PASS'];
}

export function buildReviewerPacket({ pluginRoot, trialRoot, packetRoot, trialResult }) {
  const validation = verifyTrialResult(trialResult, createForwardValidators(pluginRoot).trial);
  if (!validation.valid || trialResult.status !== 'PASS') throw coded('REVIEW_PACKET_TRIAL_INVALID');
  if (existsSync(packetRoot) && listFiles(packetRoot).length) throw coded('REVIEW_PACKET_NOT_EMPTY');
  mkdirSync(packetRoot, { recursive: true });
  const allowed = [
    ...listFiles(join(trialRoot, 'project', 'raw')).map(path => ({ source: join(trialRoot, 'project', 'raw', path), target: `raw/${path}`, role: 'raw-input' })),
    ...trialResult.author.evidenceRefs.map(path => {
      const source = safeRelative(trialRoot, path).absolute;
      const role = path.includes('/stage-results/') ? 'stage-result' : 'author-output';
      return { source, target: `evidence/${path.replaceAll('/', '__')}`, role };
    }),
    { source: join(trialRoot, 'evidence', 'trial-result.json'), target: 'evidence/trial-result.json', role: 'trial-result' },
    { source: join(pluginRoot, 'schemas', 'forward-trial-rubric.json'), target: 'contract/forward-trial-rubric.json', role: 'rubric-schema' },
  ];
  const instructions = [
    '# E2E 方法正向试验独立盲评',
    '',
    '只读取本 packet。禁止读取期望答案、其他宿主结果、其他业务包、planning/review 文档。',
    '根据 forward-trial-rubric.json 的八个维度评价实际作者链输出；每项 rationale 必须引用本 packet 内的具体文件或 case。',
    '八维全 pass 才能 overall=PASS；任一 fail 为 FAIL；其余为 PARTIAL。',
    '输出中 evidenceRefs 必须是本 packet 内的相对路径。',
  ].join('\n');
  const instructionsPath = join(packetRoot, 'REVIEW.md');
  writeFileSync(instructionsPath, `${instructions}\n`);
  allowed.push({ source: instructionsPath, target: 'REVIEW.md', role: 'instructions', alreadyThere: true });

  const files = [];
  for (const item of allowed) {
    if (!existsSync(item.source) || !lstatSync(item.source).isFile()) throw coded('REVIEW_PACKET_SOURCE_MISSING');
    const target = safeRelative(packetRoot, item.target).absolute;
    if (!item.alreadyThere) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(item.source, target, { errorOnExist: true });
    }
    files.push({ role: item.role, path: item.target, contentDigest: digestFile(target) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // 生成绑定的 reviewer 输出 schema，约束 evidenceRefs 只能引用 author-output 或 stage-result
  const allowedEvidencePaths = files
    .filter(item => ['author-output', 'stage-result'].includes(item.role))
    .map(item => item.path);
  const boundRubricSchema = createBoundRubricSchema(pluginRoot, allowedEvidencePaths);
  const boundSchemaPath = join(packetRoot, 'contract', 'bound-rubric-schema.json');
  writeFileSync(boundSchemaPath, `${JSON.stringify(boundRubricSchema, null, 2)}\n`);
  files.push({ role: 'bound-rubric-schema', path: 'contract/bound-rubric-schema.json', contentDigest: digestFile(boundSchemaPath) });

  const unsigned = {
    schemaVersion: 1,
    packetId: `review--${trialResult.hostId}--${trialResult.packageId}`,
    packageId: trialResult.packageId,
    hostId: trialResult.hostId,
    trialDigest: trialResult.digest,
    readExpectedAnswers: false,
    readOtherTrials: false,
    files,
    rubricSchemaDigest: digestFile(join(packetRoot, 'contract', 'forward-trial-rubric.json')),
    boundRubricSchemaDigest: digestFile(boundSchemaPath),
    instructionsDigest: digestFile(instructionsPath),
  };
  const packet = { ...unsigned, digest: stableDigest(unsigned) };
  writeFileSync(join(packetRoot, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
  return packet;
}

export function createBoundRubricSchema(root, allowedEvidencePaths) {
  const baseSchema = JSON.parse(readFileSync(join(root, 'schemas', 'forward-trial-rubric-review.json'), 'utf8'));
  const boundSchema = JSON.parse(JSON.stringify(baseSchema));
  const dimensionScore = boundSchema.definitions?.dimensionScore;
  if (dimensionScore?.properties?.evidenceRefs) {
    dimensionScore.properties.evidenceRefs = {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [...new Set(allowedEvidencePaths)].sort(),
      },
    };
  }

  boundSchema['$id'] = `${boundSchema['$id']}/bound`;
  return boundSchema;
}

export function verifyReviewerPacket({ packetRoot, packet, validateSchema }) {
  const diagnostics = [];
  if (!validateSchema(packet)) diagnostics.push('REVIEW_PACKET_SCHEMA_INVALID');
  if (!verifySigned(packet)) diagnostics.push('REVIEW_PACKET_DIGEST_INVALID');
  if (containsAbsolutePath(packet)) diagnostics.push('REVIEW_PACKET_PATH_LEAK');
  const declared = new Set(['packet.json', ...((packet?.files ?? []).map(item => item.path))]);
  const actual = new Set(listFiles(packetRoot));
  if (declared.size !== actual.size || [...declared].some(path => !actual.has(path))) diagnostics.push('REVIEW_PACKET_FILE_SET_MISMATCH');
  for (const item of packet?.files ?? []) {
    try {
      const path = safeRelative(packetRoot, item.path).absolute;
      if (!existsSync(path) || digestFile(path) !== item.contentDigest) diagnostics.push(`REVIEW_PACKET_FILE_DRIFT:${item.path}`);
    } catch {
      diagnostics.push(`REVIEW_PACKET_PATH_INVALID:${item.path}`);
    }
  }
  // 验证 boundRubricSchema 文件存在且摘要匹配
  if (packet?.boundRubricSchemaDigest) {
    const boundSchemaPath = join(packetRoot, 'contract', 'bound-rubric-schema.json');
    if (!existsSync(boundSchemaPath)) {
      diagnostics.push('REVIEW_PACKET_BOUND_SCHEMA_MISSING');
    } else if (digestFile(boundSchemaPath) !== packet.boundRubricSchemaDigest) {
      diagnostics.push('REVIEW_PACKET_BOUND_SCHEMA_DRIFT');
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function verifyRubric({ packetRoot, packet, rubric, validateSchema, validatePacketSchema }) {
  const diagnostics = [];
  const packetValidation = verifyReviewerPacket({ packetRoot, packet, validateSchema: validatePacketSchema });
  if (!packetValidation.valid) diagnostics.push(...packetValidation.diagnostics);

  if (!validateSchema(rubric)) diagnostics.push('RUBRIC_SCHEMA_INVALID');
  if (!verifySigned(rubric)) diagnostics.push('RUBRIC_DIGEST_INVALID');
  if (rubric?.packageId !== packet?.packageId || rubric?.hostId !== packet?.hostId) diagnostics.push('RUBRIC_IDENTITY_MISMATCH');
  let trial = null;
  try { trial = JSON.parse(readFileSync(join(packetRoot, 'evidence', 'trial-result.json'), 'utf8')); } catch {}
  if (!trial || rubric?.trialResultDigest !== packet?.trialDigest || rubric?.packetDigest !== packet?.digest ||
      rubric?.rawInputDigest !== trial?.input?.rawInputDigest ||
      rubric?.stageChainDigest !== trial?.author?.stageChainDigest || rubric?.previewDigest !== trial?.author?.previewDigest) {
    diagnostics.push('RUBRIC_TRIAL_BINDING_MISMATCH');
  }
  if (rubric?.readExpectedAnswers !== false) diagnostics.push('RUBRIC_ORACLE_LEAK');
  const scores = Object.values(rubric?.dimensions ?? {}).map(value => value?.score);
  const computed = scores.includes('fail') ? 'FAIL' : scores.every(score => score === 'pass') ? 'PASS' : 'PARTIAL';
  if (rubric?.overall !== computed) diagnostics.push('RUBRIC_OVERALL_MISMATCH');
  const allowedRefs = new Set(packet?.files?.filter(item => ['author-output', 'stage-result'].includes(item.role)).map(item => item.path));
  for (const dimension of Object.values(rubric?.dimensions ?? {})) {
    for (const ref of dimension?.evidenceRefs ?? []) if (!allowedRefs.has(ref)) diagnostics.push(`RUBRIC_EVIDENCE_ESCAPE:${ref}`);
  }
  if (containsAbsolutePath(rubric)) diagnostics.push('RUBRIC_PATH_LEAK');
  return { valid: diagnostics.length === 0, diagnostics, overall: diagnostics.length ? 'INVALID' : computed };
}

export function aggregateMethodForwardQualification({ pendingEvidence, trials, rubrics, verifiedRubrics = [], validators }) {
  const diagnostics = [];
  const expected = new Set(FORWARD_HOSTS.flatMap(host => FORWARD_PACKAGE_IDS.map(packageId => `${host}--${packageId}`)));
  const trialById = new Map();
  for (const trial of trials) {
    const checked = verifyTrialResult(trial, validators.trial);
    if (!checked.valid) diagnostics.push(...checked.diagnostics.map(code => `${trial?.trialId ?? 'unknown'}:${code}`));
    if (trialById.has(trial.trialId)) diagnostics.push(`DUPLICATE_TRIAL:${trial.trialId}`);
    trialById.set(trial.trialId, trial);
  }
  if (trialById.size !== expected.size || [...expected].some(id => !trialById.has(id))) diagnostics.push('TRIAL_SET_INCOMPLETE');
  const rubricById = new Map();
  for (const rubric of rubrics) {
    const id = `${rubric.hostId}--${rubric.packageId}`;
    if (!validators.rubric(rubric) || !verifySigned(rubric)) diagnostics.push(`RUBRIC_INVALID:${id}`);
    if (rubricById.has(id)) diagnostics.push(`DUPLICATE_RUBRIC:${id}`);
    rubricById.set(id, rubric);
  }
  if (rubricById.size !== expected.size || [...expected].some(id => !rubricById.has(id))) diagnostics.push('RUBRIC_SET_INCOMPLETE');
  const verifiedById = new Map();
  for (const verified of verifiedRubrics) {
    const rubric = rubrics.find(item => item.digest === verified.rubricDigest);
    const id = rubric ? `${rubric.hostId}--${rubric.packageId}` : null;
    if (!id || verified.status !== 'VERIFIED' || verified.trialResultDigest !== trialById.get(id)?.digest ||
        verified.packetDigest !== rubric.packetDigest || verified.overall !== rubric.overall || !verifySigned(verified)) {
      diagnostics.push(`VERIFIED_RUBRIC_INVALID:${id || 'unknown'}`);
      continue;
    }
    if (verifiedById.has(id)) diagnostics.push(`DUPLICATE_VERIFIED_RUBRIC:${id}`);
    verifiedById.set(id, verified);
  }
  if (verifiedById.size !== expected.size || [...expected].some(id => !verifiedById.has(id))) diagnostics.push('VERIFIED_RUBRIC_SET_INCOMPLETE');
  const syntheticEvidence = [...trialById.values()].some(item => item.evidenceMode !== 'real') ||
    [...verifiedById.values()].some(item => item.evidenceMode !== 'real');
  if (syntheticEvidence) diagnostics.push('NON_CERTIFYING_SYNTHETIC_EVIDENCE');
  if ([...rubricById.values()].some(item => !['llm', 'human'].includes(item.reviewer?.type))) diagnostics.push('RUBRIC_REVIEWER_NOT_SEMANTIC');

  const rubricCounts = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  for (const rubric of rubricById.values()) rubricCounts[rubric.overall] = (rubricCounts[rubric.overall] ?? 0) + 1;
  const complete = diagnostics.length === 0;
  const blocked = [...trialById.values()].some(item => item.status === 'BLOCKED');
  const qualified = complete && !syntheticEvidence && [...trialById.values()].every(item => item.status === 'PASS') && rubricCounts.PASS === expected.size;
  const status = qualified ? 'QUALIFIED' : blocked || !complete ? 'BLOCKED' : 'NOT_QUALIFIED';
  const hostRecord = schemaHost => {
    const hostId = schemaHost === 'claude' ? 'claude-code' : schemaHost;
    const hostTrials = FORWARD_PACKAGE_IDS.map(packageId => {
      const trial = trialById.get(`${hostId}--${packageId}`);
      const rubric = rubricById.get(`${hostId}--${packageId}`);
      return {
        packageId,
        rawInputDigest: trial?.input?.rawInputDigest ?? `sha256:${'0'.repeat(64)}`,
        projectFactsDigest: trial?.input?.projectFactsDigest ?? `sha256:${'0'.repeat(64)}`,
        goalDigest: trial?.input?.goalDigest ?? `sha256:${'0'.repeat(64)}`,
        hostInvocationDigest: trial?.invocation?.hostInvocationDigest ?? `sha256:${'0'.repeat(64)}`,
        eventStreamDigest: trial?.invocation?.eventStreamDigest ?? `sha256:${'0'.repeat(64)}`,
        authorChainCompleted: trial?.author?.chainCompleted === true,
        stageChainDigest: trial?.author?.stageChainDigest ?? null,
        stageResultsManifestDigest: trial?.author?.stageResultsManifestDigest ?? null,
        previewManifestDigest: trial?.author?.previewDigest ?? null,
        artifactPackageDigest: trial?.author?.artifactPackageDigest ?? null,
        reviewerPacketDigest: rubric?.packetDigest ?? null,
        rubricDigest: rubric?.digest ?? null,
        exitSummary: trial?.code ?? 'MISSING',
        zeroUnauthorizedWrites: trial?.isolation?.zeroUnauthorizedWrites === true,
        absolutePathDetected: trial?.isolation?.absolutePathDetected === true,
        writeDelta: trial?.isolation?.writeDelta ?? [],
      };
    });
    return {
      status: qualified ? 'QUALIFIED' : blocked ? 'BLOCKED' : 'NOT_QUALIFIED',
      cliVersion: trialById.get(`${hostId}--${FORWARD_PACKAGE_IDS[0]}`)?.invocation?.cliVersion ?? 'unavailable',
      trials: hostTrials,
    };
  };
  const { digest: _oldDigest, pendingMarkers: _pending, hosts: _oldHosts, rubricSummary: _oldSummary, qualificationStatus: _oldStatus, ...base } = pendingEvidence;
  const evidence = signMethodForwardQualification({
    ...base,
    qualificationStatus: status,
    hosts: { codex: hostRecord('codex'), claude: hostRecord('claude') },
    rubricSummary: { passCount: rubricCounts.PASS, partialCount: rubricCounts.PARTIAL, failCount: rubricCounts.FAIL },
  });
  if (!validators.qualification(evidence)) diagnostics.push('QUALIFICATION_SCHEMA_INVALID');
  return { evidence, diagnostics: [...new Set(diagnostics)].sort() };
}

function verifySigned(value) {
  if (!value || typeof value !== 'object') return false;
  const { digest, ...unsigned } = value;
  return isDigest(digest) && stableDigest(unsigned) === digest;
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}
