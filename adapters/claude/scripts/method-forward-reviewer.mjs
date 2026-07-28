#!/usr/bin/env node

/** 方法正向试验独立盲评的 packet / run / verify 控制平面。 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { parseClaudeEvents, parseCodexEvents, snapshotTree, stableDigest } from './lib/behavior-qualification.mjs';
import {
  buildReviewerPacket, createForwardValidators, digestFile, listFiles,
  resolveForwardTimeoutMs, verifyReviewerPacket, verifyRubric,
} from './lib/method-forward-trials.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const action = argv[0];
const jsonMode = argv.includes('--json');
const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };

// 盲评访问证明的只读命令语义验证常量。必须在 CLI 入口之前初始化，
// 否则 run() → reviewAccess() → analyzeReadCommand() 在 TDZ 中引用这些常量会抛
// ReferenceError（函数声明被提升但 const 绑定不被提升）。
const REVIEW_READ_COMMANDS = new Set(['cat', 'sed', 'find', 'rg', 'wc', 'jq', 'head', 'tail', 'echo', 'pwd', 'exit']);
const REVIEW_CONTENT_READ_COMMANDS = new Set(['cat', 'sed', 'rg', 'wc', 'jq', 'head', 'tail']);
const REVIEW_SHELL_NAME = /(?:^|\/)(?:zsh|bash|sh|dash|ksh|fish|ash|csh|tcsh|env)$/;
const REVIEW_LOOP_VAR_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

// CLI 入口仅在本文件作为主模块直接执行时运行；被单元测试 import（取 reviewAccess）时
// 保持惰性，不触发 prepare/run/verify，也不改写退出码或 stdout。
// 用 argv[1] 文件名后缀判定而非 import.meta.url === pathToFileURL(argv[1]).href：
// 后者在经符号链接路径调用时不成立（macOS /tmp→/private/tmp、/var→/private/var，
// npm 安装态黑盒测试即经此类路径调用），会被误判为非主模块而静默 no-op。
// 与 method-forward-trial-runner.mjs 的主模块判定约定保持一致。
const isMainModule = Boolean(process.argv[1]) && process.argv[1].endsWith('method-forward-reviewer.mjs');
if (isMainModule) {
  try {
    let result;
    if (action === 'prepare') result = prepare();
    else if (action === 'run') result = run();
    else if (action === 'verify') result = verify();
    else throw coded('REVIEW_ACTION_INVALID');
    process.stdout.write(`${JSON.stringify(result, null, jsonMode ? 2 : 0)}\n`);
    if (result.status === 'BLOCKED') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: codeOf(error) }, null, jsonMode ? 2 : 0)}\n`);
    process.exitCode = 1;
  }
}

function prepare() {
  const trialRoot = absolute('--trial-root');
  const packetRoot = absolute('--packet-root');
  if (existsSync(packetRoot) && readdirSync(packetRoot).length) throw coded('REVIEW_PACKET_ROOT_NOT_EMPTY');
  const trialPath = join(trialRoot, 'evidence', 'trial-result.json');
  if (!existsSync(trialPath)) throw coded('REVIEW_PACKET_TRIAL_MISSING');
  const trialResult = JSON.parse(readFileSync(trialPath, 'utf8'));
  const packet = buildReviewerPacket({ pluginRoot, trialRoot, packetRoot, trialResult });
  const validators = createForwardValidators(pluginRoot);
  const checked = verifyReviewerPacket({ packetRoot, packet, validateSchema: validators.packet });
  if (!checked.valid) throw coded('REVIEW_PACKET_INVALID');
  return { status: 'REVIEW_PACKET_PREPARED', packetId: packet.packetId, digest: packet.digest };
}

function run() {
  const packetRoot = absolute('--packet-root');
  const outputRoot = absolute('--output-root');
  const reviewerHost = value('--reviewer-host');
  const reviewerCommand = absolute('--reviewer-command');
  const evidenceMode = value('--evidence-mode') || 'real';
  // Recovery-25 WP1：预算经与 trial 相同的共享 helper 解析（默认 1,200,000ms、
  // 上限 1,800,000ms、下限 1,000ms），保证 trial/reviewer 预算合同同构。
  // 优先级保持：--timeout-ms > E2E_TEST_FORWARD_TIMEOUT_MS > 默认值；
  // 非法预算抛 FORWARD_TIMEOUT_INVALID，由顶层 catch 输出 {status:'BLOCKED',code}。
  const timeoutMs = resolveForwardTimeoutMs(value('--timeout-ms'), process.env.E2E_TEST_FORWARD_TIMEOUT_MS);
  if (!['codex', 'claude-code'].includes(reviewerHost) || !['real', 'synthetic'].includes(evidenceMode)) throw coded('REVIEW_RUN_ARGUMENT_INVALID');
  if (existsSync(outputRoot) && readdirSync(outputRoot).length) throw coded('REVIEW_OUTPUT_ROOT_NOT_EMPTY');
  mkdirSync(outputRoot, { recursive: true });
  const packet = JSON.parse(readFileSync(join(packetRoot, 'packet.json'), 'utf8'));
  const validators = createForwardValidators(pluginRoot);
  const checked = verifyReviewerPacket({ packetRoot, packet, validateSchema: validators.packet });
  if (!checked.valid) throw coded('REVIEW_PACKET_INVALID');
  const schemaPath = join(packetRoot, 'contract', 'bound-rubric-schema.json');
  // 宿主兼容性投影（确证缺口修复，与 Recovery-13 顶层 oneOf 修复同类）：
  // codex 后端的 strict response_format 拒绝 uniqueItems 关键字（invalid_json_schema），
  // 仅为 codex 调用投影一份去掉 uniqueItems 的 schema 写入 outputRoot（不进入 packet 盲评边界）；
  // 语义合同不变：verify 阶段仍按 schemas/ 规范 schema（含 uniqueItems）校验最终 rubric。
  const hostSchemaPath = reviewerHost === 'codex' ? projectCodexBoundSchema(schemaPath, outputRoot) : schemaPath;
  const prompt = [
    '你是独立 E2E 方法正向试验盲评者。只允许读取当前 packet 根，不得读取其他路径、其他试验、期望答案或既有 rubric。',
    `packet 根：${packetRoot}`,
    '完整读取 packet.json、REVIEW.md 及 packet manifest 列出的 raw/evidence/contract 文件。',
    '只读命令面（控制平面据此做盲评访问证明，超出即判越权并丢弃本次盲评）：仅可使用 cat、sed、find、rg、wc、jq、head、tail、echo、pwd、exit，以及 for 循环和 ;、&&、|| 分隔。禁止 printf、sort、shell 管道（|）、写重定向、命令替换、解释器、任何写命令、网络、git、子智能体与 packet 外路径。',
    '按八维评分；每项 evidenceRefs 必须精确引用 packet.json 中 role 为 author-output 或 stage-result 的相对路径。允许值已经编译进 contract/bound-rubric-schema.json，禁止引用 raw-input。',
    '八维全部 pass 才能 PASS；任一 fail 为 FAIL；其余为 PARTIAL。不要修改任何文件，不要运行网络、git、子智能体或业务命令。',
  ].join('\n\n');
  const version = hostVersion(reviewerCommand);
  const hostArgs = reviewerHost === 'codex'
    ? ['exec', '--json', '--output-schema', hostSchemaPath, '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', packetRoot, prompt]
    : claudeReviewerArgs({ prompt, schemaPath, packetRoot, environment: reviewerEnvironment(evidenceMode) });
  const before = snapshotTree(packetRoot).digest;
  const invocation = spawnSync(reviewerCommand, hostArgs, {
    cwd: packetRoot, env: reviewerEnvironment(evidenceMode),
    encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: 24 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  function reviewerEnvironment(mode) {
    return scrubbedEnvironment({
      E2E_FORWARD_REVIEW_PACKET_ROOT: packetRoot,
      E2E_FORWARD_REVIEWER_HOST: reviewerHost,
      E2E_FORWARD_REVIEW_EVIDENCE_MODE: mode,
      ...(mode === 'synthetic' && process.env.E2E_FAKE_REVIEW_MODE
        ? { E2E_FAKE_REVIEW_MODE: process.env.E2E_FAKE_REVIEW_MODE }
        : {}),
    });
  }
  const after = snapshotTree(packetRoot).digest;
  let parsed = null;
  try { parsed = reviewerHost === 'codex' ? parseCodexEvents(invocation.stdout) : parseClaudeEvents(invocation.stdout); } catch {}
  const access = reviewAccess(parsed?.tools || [], packetRoot);
  const eventsPath = join(outputRoot, 'review-events.jsonl');
  writeFileSync(eventsPath, invocation.stdout || '');
  const accessCore = {
    schemaVersion: 1,
    kind: 'method-forward-review-access',
    packetId: packet.packetId,
    packetDigest: packet.digest,
    evidenceMode,
    reviewerHost,
    reviewerVersion: version,
    invocationDigest: stableDigest({ executableDigest: digestFile(reviewerCommand), argumentsDigest: stableDigest(hostArgs) }),
    eventStreamDigest: digestFile(eventsPath),
    packetBeforeDigest: before,
    packetAfterDigest: after,
    packetReadVerified: access.packetReadVerified,
    unexpectedToolDetected: access.unexpectedToolDetected,
    exitCode: invocation.status,
    timedOut: invocation.error?.code === 'ETIMEDOUT',
  };
  const accessReceipt = { ...accessCore, digest: stableDigest(accessCore) };
  writeFileSync(join(outputRoot, 'access-receipt.json'), `${JSON.stringify(accessReceipt, null, 2)}\n`);
  if (!parsed?.receipt || invocation.status !== 0 || accessReceipt.timedOut || before !== after || !access.packetReadVerified || access.unexpectedToolDetected) {
    return { status: 'BLOCKED', code: accessReceipt.timedOut ? 'REVIEW_TIMEOUT' : 'RUBRIC_BLINDNESS_UNPROVEN', digest: accessReceipt.digest };
  }
  const draft = parsed.receipt;
  const validateDraft = draftValidator(hostSchemaPath);
  if (!validateDraft(draft)) throw coded('RUBRIC_REVIEW_SCHEMA_INVALID');
  const trial = JSON.parse(readFileSync(join(packetRoot, 'evidence', 'trial-result.json'), 'utf8'));
  const rubricCore = {
    schemaVersion: 1,
    packageId: packet.packageId,
    hostId: packet.hostId,
    packetDigest: packet.digest,
    trialResultDigest: packet.trialDigest,
    rawInputDigest: trial.input.rawInputDigest,
    stageChainDigest: trial.author.stageChainDigest,
    previewDigest: trial.author.previewDigest,
    accessEvidenceDigest: accessReceipt.digest,
    reviewer: { type: 'llm', identity: `${reviewerHost}:${version}` },
    readExpectedAnswers: false,
    dimensions: draft.dimensions,
    overall: draft.overall,
    summary: draft.summary,
  };
  const rubric = { ...rubricCore, digest: stableDigest(rubricCore) };
  writeFileSync(join(outputRoot, 'rubric.json'), `${JSON.stringify(rubric, null, 2)}\n`);
  return { status: 'REVIEW_COMPLETE', overall: rubric.overall, digest: rubric.digest };
}

function verify() {
  const packetRoot = absolute('--packet-root');
  const outputRoot = absolute('--output-root');
  const packet = JSON.parse(readFileSync(join(packetRoot, 'packet.json'), 'utf8'));
  const rubric = JSON.parse(readFileSync(join(outputRoot, 'rubric.json'), 'utf8'));
  const access = JSON.parse(readFileSync(join(outputRoot, 'access-receipt.json'), 'utf8'));
  const validators = createForwardValidators(pluginRoot);
  const accessValid = signed(access) && access.packetId === packet.packetId && access.packetDigest === packet.digest &&
    access.packetBeforeDigest === access.packetAfterDigest && access.packetAfterDigest === snapshotTree(packetRoot).digest &&
    access.packetReadVerified === true && access.unexpectedToolDetected === false && access.exitCode === 0 && access.timedOut === false;
  const checked = verifyRubric({
    packetRoot, packet, rubric, validateSchema: validators.rubric, validatePacketSchema: validators.packet,
  });
  const bindingValid = rubric.packetDigest === packet.digest && rubric.trialResultDigest === packet.trialDigest &&
    rubric.accessEvidenceDigest === access.digest;
  const valid = accessValid && checked.valid && bindingValid;
  const resultCore = {
    schemaVersion: 1,
    kind: 'verified-forward-rubric',
    status: valid ? 'VERIFIED' : 'BLOCKED',
    packetDigest: packet.digest,
    trialResultDigest: packet.trialDigest,
    rubricDigest: rubric.digest,
    overall: valid ? checked.overall : 'INVALID',
    accessEvidenceDigest: access.digest,
    evidenceMode: access.evidenceMode,
    diagnostics: [...new Set([...(checked.diagnostics || []), ...(!accessValid ? ['RUBRIC_BLINDNESS_UNPROVEN'] : []), ...(!bindingValid ? ['RUBRIC_BINDING_MISMATCH'] : [])])].sort(),
  };
  const result = { ...resultCore, digest: stableDigest(resultCore) };
  writeFileSync(join(outputRoot, 'verified-rubric.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function reviewAccess(tools, packetRoot) {
  const root = resolve(packetRoot);
  const successful = tools.filter(item => item.success === true);
  // Claude Code reviewer 走宿主 Read 工具（kind='read'），其判定逻辑保持不变：
  // 成功读取且路径落在 packet root 内即计入真实读取。
  const reads = successful.filter(item => item.kind === 'read' && resolve(item.value).startsWith(`${root}/`));
  const commands = successful.filter(item => item.kind === 'command');
  // Codex CLI 的只读命令由宿主以 /bin/zsh -lc '<inner>' 或 /bin/zsh -c '<inner>' 包装、使用
  // packet cwd 内相对路径（Recovery-26 WP1：连接重连恢复后宿主可能从 -lc 变为 -c，两者同等接受）。
  // 把「宿主 shell 包装」与「内层命令语义」分开：只接受这两种精确三 token 包装，对内层
  // 命令逐条做最小化只读语义验证，相对路径规范化后必须仍位于 packet root。
  const analyzed = commands.map(item => analyzeReadCommand(String(item.value || ''), root));
  return {
    packetReadVerified: reads.length > 0 || analyzed.some(item => item.ok && item.contentRead),
    // 越权工具即使被宿主拒绝，也证明评审者尝试突破盲评边界；不得只检查成功调用。
    unexpectedToolDetected: tools.some(item => item.kind === 'other' || item.kind === 'write' ||
      (item.kind === 'command' && !analyzeReadCommand(String(item.value || ''), root).ok)),
  };
}

// 盲评访问证明的只读命令语义验证。返回 { ok, contentRead }：ok 表示命令完全落在最小只读
// 允许面内且所有路径都在 packet root 中；contentRead 表示至少真实读取了 packet 文件内容
// （而非仅 pwd / 目录枚举）。任何写重定向、命令替换、解释器、网络、越界路径、非
// /bin/zsh -lc 且非 /bin/zsh -c 的 shell 包装都会使 ok=false。
// REVIEW_READ_COMMANDS / REVIEW_SHELL_NAME 等常量已提前到 CLI 入口之前初始化（避免 TDZ）。

function analyzeReadCommand(command, root) {
  try {
    const tokens = tokenizeShellLine(command);
    // 宿主 shell 包装：只接受两种精确三 token 形状 /bin/zsh -lc '<inner>' 与 /bin/zsh -c '<inner>'
    // （单/双引号皆可）。Recovery-26 WP1：codex-cli 在传输重连（Connection reset by peer）恢复后
    // 可能以 -c（无 -l）包装同一条只读命令；R25 阻断盲评即因宿主从 -lc 变为 -c 而被误判越权，
    // 而两份同样经历连接重置的成功盲评仅因保持 -lc 而通过。包装形式是宿主行为差异，与业务包
    // 答案或评审内容无关，故 -c 与 -lc 必须同等接受。两种包装复用完全相同的 validateInnerProgram：
    // 内层允许命令、路径规范化、循环语义与全部拒绝规则一字不改。
    // 仍拒绝：bash/sh/其它 shell 名称、非精确参数（如 -l/-i/-lcx）、额外 token、包装后追加命令、嵌套 shell。
    if (tokens.length > 0 && tokens[0].type === 'word' && REVIEW_SHELL_NAME.test(tokens[0].value)) {
      if (tokens.length === 3 && tokens[0].value === '/bin/zsh' && tokens[1].type === 'word' &&
          (tokens[1].value === '-lc' || tokens[1].value === '-c') && tokens[2].type === 'word') {
        return validateInnerProgram(tokens[2].value, root);
      }
      return { ok: false, contentRead: false };
    }
    // 裸命令（无 shell 包装）：直接对内层语义验证，相对路径以 packet root 为 cwd 规范化。
    return validateInnerProgram(command, root);
  } catch {
    return { ok: false, contentRead: false };
  }
}

function validateInnerProgram(inner, root) {
  // 命令替换（$(...)、反引号）在任何位置都拒绝；${VAR} 循环变量引用在路径校验处单独放行。
  if (inner.includes('$(') || inner.includes('`')) return { ok: false, contentRead: false };
  const tokens = tokenizeShellLine(inner);
  const ctx = { i: 0, root, loopVars: new Set(), contentRead: false };
  parseReviewList(tokens, ctx);
  if (ctx.i !== tokens.length) throw new Error('REVIEW_COMMAND_TRAILING_TOKENS');
  return { ok: true, contentRead: ctx.contentRead };
}

// list := command ((;|&&|\|\|) command)* ；在 done 或结尾停止（允许尾随分隔符）。
function parseReviewList(tokens, ctx) {
  parseReviewCommand(tokens, ctx);
  while (ctx.i < tokens.length) {
    const token = tokens[ctx.i];
    if (token.type === 'op' && [';', '&&', '||'].includes(token.value)) {
      ctx.i += 1;
      if (ctx.i >= tokens.length) break;
      if (tokens[ctx.i].type === 'word' && tokens[ctx.i].value === 'done') break;
      parseReviewCommand(tokens, ctx);
    } else if (token.type === 'op') {
      // 写重定向 / 管道 / 后台（>, >>, <, |, & 等）一律拒绝。
      throw new Error('REVIEW_COMMAND_FORBIDDEN_OPERATOR');
    } else {
      break; // done 或上下文末尾
    }
  }
}

function parseReviewCommand(tokens, ctx) {
  const token = tokens[ctx.i];
  if (!token || token.type !== 'word') throw new Error('REVIEW_COMMAND_EMPTY');
  if (token.value === 'for') parseReviewFor(tokens, ctx);
  else parseReviewSimple(tokens, ctx);
}

function parseReviewFor(tokens, ctx) {
  ctx.i += 1; // for
  const varToken = tokens[ctx.i];
  if (!varToken || varToken.type !== 'word' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(varToken.value)) throw new Error('REVIEW_FOR_VAR_INVALID');
  ctx.i += 1;
  const inToken = tokens[ctx.i];
  if (!inToken || inToken.type !== 'word' || inToken.value !== 'in') throw new Error('REVIEW_FOR_IN_MISSING');
  ctx.i += 1;
  const words = [];
  while (ctx.i < tokens.length && !(tokens[ctx.i].type === 'op' && tokens[ctx.i].value === ';') &&
      !(tokens[ctx.i].type === 'word' && tokens[ctx.i].value === 'do')) {
    const word = tokens[ctx.i];
    if (word.type !== 'word') throw new Error('REVIEW_FOR_WORD_INVALID');
    words.push(word.value);
    ctx.i += 1;
  }
  if (words.length === 0) throw new Error('REVIEW_FOR_WORDS_EMPTY');
  if (ctx.i < tokens.length && tokens[ctx.i].type === 'op' && tokens[ctx.i].value === ';') ctx.i += 1;
  const doToken = tokens[ctx.i];
  if (!doToken || doToken.type !== 'word' || doToken.value !== 'do') throw new Error('REVIEW_FOR_DO_MISSING');
  ctx.i += 1;
  // 循环取值集合必须先逐条证明位于 packet root 内，循环体内 $VAR 才可按已验证路径放行。
  for (const word of words) reviewPathWord(word, root(ctx), ctx.loopVars);
  ctx.loopVars.add(varToken.value);
  parseReviewList(tokens, ctx);
  const doneToken = tokens[ctx.i];
  if (!doneToken || doneToken.type !== 'word' || doneToken.value !== 'done') throw new Error('REVIEW_FOR_DONE_MISSING');
  ctx.i += 1;
  ctx.loopVars.delete(varToken.value);
}

function root(ctx) { return ctx.root; }

function parseReviewSimple(tokens, ctx) {
  const args = [];
  while (ctx.i < tokens.length) {
    const token = tokens[ctx.i];
    if (token.type === 'op') break;
    if (token.type === 'word' && token.value === 'done') break;
    args.push(token.value);
    ctx.i += 1;
  }
  validateReviewSimple(args, ctx);
}

function validateReviewSimple(args, ctx) {
  if (args.length === 0) throw new Error('REVIEW_COMMAND_EMPTY');
  const name = args[0];
  if (name.includes('=') || REVIEW_SHELL_NAME.test(name) || !REVIEW_READ_COMMANDS.has(name)) {
    throw new Error('REVIEW_COMMAND_NOT_ALLOWED');
  }
  const rest = args.slice(1);
  switch (name) {
    case 'pwd':
      for (const arg of rest) if (arg !== '-P' && arg !== '-L') throw new Error('REVIEW_PWD_ARG_INVALID');
      return;
    case 'exit':
      if (rest.length > 1 || (rest.length === 1 && !/^\d+$/.test(rest[0]))) throw new Error('REVIEW_EXIT_ARG_INVALID');
      return;
    case 'echo':
      // echo 只打印，不触碰文件系统；命令替换/反引号已在 validateInnerProgram 全局拒绝。
      for (const arg of rest) if (arg.includes('$(') || arg.includes('`')) throw new Error('REVIEW_ECHO_UNSAFE');
      return;
    case 'cat': {
      const paths = rest.filter(arg => !arg.startsWith('-'));
      if (paths.length === 0) throw new Error('REVIEW_CAT_NO_PATH');
      for (const arg of rest) if (arg === '-') throw new Error('REVIEW_CAT_STDIN');
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    case 'wc': {
      const paths = rest.filter(arg => !arg.startsWith('-'));
      if (paths.length === 0) throw new Error('REVIEW_WC_NO_PATH');
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    case 'head':
    case 'tail': {
      const paths = [];
      for (let k = 0; k < rest.length; k += 1) {
        const arg = rest[k];
        if (arg === '-f' || arg === '--follow' || arg.startsWith('--follow=')) throw new Error('REVIEW_TAIL_FOLLOW');
        if (arg === '-n' || arg === '-c' || arg === '--lines' || arg === '--bytes') { k += 1; continue; }
        if (arg.startsWith('-')) continue;
        paths.push(arg);
      }
      if (paths.length === 0) throw new Error('REVIEW_HEAD_NO_PATH');
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    case 'sed': {
      if (!rest.some(arg => arg === '-n' || arg === '--quiet' || arg === '--silent')) throw new Error('REVIEW_SED_NOT_QUIET');
      if (rest.some(arg => arg === '-i' || arg.startsWith('-i.') || arg === '--in-place' || arg.startsWith('--in-place='))) throw new Error('REVIEW_SED_INPLACE');
      const scriptIndex = rest.findIndex(arg => !arg.startsWith('-'));
      if (scriptIndex < 0) throw new Error('REVIEW_SED_NO_SCRIPT');
      const script = rest[scriptIndex];
      if (!/^(?:[0-9]+(?:,[0-9]+)?|\$|\/[^/]*\/)?p$/.test(script)) throw new Error('REVIEW_SED_SCRIPT_NOT_PRINT');
      const paths = rest.slice(scriptIndex + 1).filter(arg => !arg.startsWith('-'));
      if (paths.length === 0) throw new Error('REVIEW_SED_NO_PATH');
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    case 'find': {
      const paths = [];
      let k = 0;
      for (; k < rest.length; k += 1) {
        const arg = rest[k];
        if (arg.startsWith('-') || arg === '!' || arg === '(' || arg === ')') break;
        paths.push(arg);
      }
      if (paths.length === 0) throw new Error('REVIEW_FIND_NO_PATH');
      const expression = rest.slice(k);
      const forbidden = ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'];
      if (expression.some(arg => forbidden.includes(arg))) throw new Error('REVIEW_FIND_WRITE_EXEC');
      for (const path of paths) reviewPathArg(path, ctx);
      return; // find 是目录枚举，不计入内容读取
    }
    case 'rg': {
      const patternIndex = rest.findIndex(arg => !arg.startsWith('-'));
      if (patternIndex < 0) throw new Error('REVIEW_RG_NO_PATTERN');
      const paths = rest.slice(patternIndex + 1).filter(arg => !arg.startsWith('-'));
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    case 'jq': {
      if (rest.some(arg => arg === '-w' || arg === '--write' || arg.startsWith('--write') || arg === '-i' || arg === '--inplace')) throw new Error('REVIEW_JQ_WRITE');
      const filterIndex = rest.findIndex(arg => !arg.startsWith('-'));
      if (filterIndex < 0) throw new Error('REVIEW_JQ_NO_FILTER');
      const filter = rest[filterIndex];
      if (/system\s*\(/.test(filter) || filter.includes('system')) throw new Error('REVIEW_JQ_SYSTEM');
      const paths = rest.slice(filterIndex + 1).filter(arg => !arg.startsWith('-'));
      if (paths.length === 0) throw new Error('REVIEW_JQ_NO_PATH');
      for (const path of paths) reviewPathArg(path, ctx);
      ctx.contentRead = true;
      return;
    }
    default:
      throw new Error('REVIEW_COMMAND_NOT_ALLOWED');
  }
}

// 路径参数：循环变量引用（$VAR / ${VAR}）按其取值集合已验证放行；其它一律规范化后证明位于
// packet root 内，拒绝 .. 逃逸、root 外绝对路径与含未知 $ 展开的参数。
function reviewPathArg(arg, ctx) {
  reviewPathWord(arg, ctx.root, ctx.loopVars);
}

function reviewPathWord(word, packetRoot, loopVars) {
  const ref = word.match(REVIEW_LOOP_VAR_REF);
  if (ref && loopVars.has(ref[1])) return;
  if (word.includes('$') || word.includes('`')) throw new Error('REVIEW_PATH_EXPANSION');
  if (/(?:^|\/)\.\.(?:\/|$)/.test(word)) throw new Error('REVIEW_PATH_ESCAPE');
  const absolute = isAbsolute(word) ? resolve(word) : resolve(packetRoot, word);
  if (absolute !== packetRoot && !absolute.startsWith(`${packetRoot}/`)) throw new Error('REVIEW_PATH_OUTSIDE_ROOT');
}

// 最小 shell 词法器：识别单/双引号、相邻段拼接，并把分隔符 ; && || 与重定向/管道操作符
// （> >> < | & 等）切成独立 op token，供上层语义校验精确拒绝。
function tokenizeShellLine(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  const isOpStart = ch => ';&|<>'.includes(ch);
  const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (i < n) {
    const ch = input[i];
    if (isSpace(ch)) { i += 1; continue; }
    if (isOpStart(ch)) {
      let op = ch;
      i += 1;
      if (i < n && ((ch === '&' && input[i] === '&') || (ch === '|' && input[i] === '|') ||
          (ch === '>' && input[i] === '>') || (ch === '<' && input[i] === '<'))) {
        op += input[i];
        i += 1;
      }
      tokens.push({ type: 'op', value: op });
      continue;
    }
    let buf = '';
    while (i < n && !isSpace(input[i]) && !isOpStart(input[i])) {
      const c = input[i];
      if (c === "'") {
        let j = i + 1;
        while (j < n && input[j] !== "'") j += 1;
        if (j >= n) throw new Error('REVIEW_QUOTE_UNTERMINATED');
        buf += input.slice(i + 1, j);
        i = j + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < n && input[j] !== '"') {
          if (input[j] === '\\' && j + 1 < n) j += 1;
          j += 1;
        }
        if (j >= n) throw new Error('REVIEW_QUOTE_UNTERMINATED');
        buf += input.slice(i + 1, j).replace(/\\(.)/g, '$1');
        i = j + 1;
      } else if (c === '\\' && i + 1 < n) {
        buf += input[i + 1];
        i += 2;
      } else {
        buf += c;
        i += 1;
      }
    }
    tokens.push({ type: 'word', value: buf });
  }
  return tokens;
}

function draftValidator(schemaPath) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
}
// codex strict response_format 不接受 uniqueItems；投影仅剔除该关键字，其余结构逐字保留。
function projectCodexBoundSchema(sourcePath, outputRoot) {
  const stripUnsupported = value => {
    if (Array.isArray(value)) return value.map(stripUnsupported);
    if (value && typeof value === 'object') {
      const next = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === 'uniqueItems') continue;
        next[key] = stripUnsupported(item);
      }
      return next;
    }
    return value;
  };
  const projected = stripUnsupported(JSON.parse(readFileSync(sourcePath, 'utf8')));
  const target = join(outputRoot, 'bound-rubric-schema.codex.json');
  writeFileSync(target, `${JSON.stringify(projected, null, 2)}\n`);
  return target;
}
function claudeReviewerArgs({ prompt, schemaPath, packetRoot, environment }) {
  const settings = {
    permissions: { defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable', allow: [`Read(//${resolve(packetRoot).replace(/^\/+/, '')}/**)`], deny: ['Write', 'Edit', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'] },
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, excludedCommands: [], allowUnsandboxedCommands: false, filesystem: { allowWrite: [], denyWrite: [resolve(packetRoot)], denyRead: [], allowRead: [resolve(packetRoot)] }, credentials: { files: ['~/.ssh', '~/.aws', '~/.azure', '~/.config/gcloud', '~/.config/gh', '~/.npmrc', '~/.netrc', '~/.git-credentials', '~/.claude'].map(path => ({ path, mode: 'deny' })), envVars: protectedEnvironmentNames(environment).map(name => ({ name, mode: 'deny' })) }, network: { allowedDomains: [], deniedDomains: ['*'], allowUnixSockets: [], allowLocalBinding: false } },
    autoMemoryEnabled: false, fileCheckpointingEnabled: false, includeGitInstructions: false,
  };
  return ['-p', '--output-format', 'stream-json', '--json-schema', readFileSync(schemaPath, 'utf8').trim(), '--tools', 'Read', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', ...settings.permissions.allow, '--disallowedTools', ...settings.permissions.deny, '--setting-sources', '', '--settings', JSON.stringify(settings), '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', prompt];
}
function hostVersion(command) { try { return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { throw coded('REVIEW_HOST_UNAVAILABLE'); } }
function scrubbedEnvironment(extra = {}) { const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']); const provider = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|GCP|VERTEX)_/; return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key) || provider.test(key))), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...extra }; }
function protectedEnvironmentNames(environment) { const credential = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION)/i; const provider = /^(?:ANTHROPIC|OPENAI|CODEX|CLAUDE|AWS|AZURE|GOOGLE|GCP|VERTEX)_/; return Object.keys(environment || {}).filter(name => credential.test(name) || provider.test(name)).sort(); }
function signed(value) { if (!value || typeof value !== 'object') return false; const { digest, ...unsigned } = value; return stableDigest(unsigned) === digest; }
function absolute(flag) { const item = value(flag); if (!item || !isAbsolute(item)) throw coded('REVIEW_ABSOLUTE_PATH_REQUIRED'); return resolve(item); }
function coded(code) { return Object.assign(new Error(code), { code }); }
function codeOf(error) { return String(error?.code || error?.message || 'REVIEW_FAILED').match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'REVIEW_FAILED'; }

// 仅为单元测试暴露 module-private 的访问证明判定；CLI 入口在文件顶部已同步执行，
// 该导出不改变 prepare/run/verify 的行为。
export { reviewAccess };
