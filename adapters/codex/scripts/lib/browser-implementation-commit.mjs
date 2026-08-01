/**
 * M4-D BindingManifest、preview 与一次性 commit controller。
 *
 * 顶层不导出签发或写入函数。受信任宿主创建 controller 后，句柄 secret、HMAC
 * authority 与状态机均封装在闭包；草稿 provider/reviewer 只接触零写入 preview。
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { prepareImplementationPlan } from './browser-implementation-planner.mjs';
import { readTrustedCodeReviewContext } from './browser-code-review.mjs';
import { stableDigest } from './digest.mjs';
import { validateSchema } from './schema-validation.mjs';

const PREVIEW_CONTRACT = 'e2e-test/implementation-commit-preview/v1';
const HANDLE_CONTRACT = 'e2e-test/implementation-commit-handle/v1';
const TRUSTED_COMMIT_PREVIEWS = new WeakMap();
const TRUSTED_COMMIT_RESULTS = new WeakMap();

export const COMMIT_FAILURE_CODES = Object.freeze({
  M4_COMMIT_REVIEW_UNTRUSTED: 'M4_COMMIT_REVIEW_UNTRUSTED',
  M4_COMMIT_DUPLICATE_TARGET: 'M4_COMMIT_DUPLICATE_TARGET',
  M4_COMMIT_TARGET_UNSAFE: 'M4_COMMIT_TARGET_UNSAFE',
  M4_COMMIT_TARGET_DRIFT: 'M4_COMMIT_TARGET_DRIFT',
  M4_COMMIT_PREVIEW_SCHEMA_INVALID: 'M4_COMMIT_PREVIEW_SCHEMA_INVALID',
  M4_COMMIT_CONTROLLER_INVALID: 'M4_COMMIT_CONTROLLER_INVALID',
  M4_COMMIT_HANDLE_INVALID: 'M4_COMMIT_HANDLE_INVALID',
  M4_COMMIT_HANDLE_EXPIRED: 'M4_COMMIT_HANDLE_EXPIRED',
  M4_COMMIT_HANDLE_SECRET_MISMATCH: 'M4_COMMIT_HANDLE_SECRET_MISMATCH',
  M4_COMMIT_HANDLE_SCOPE_MISMATCH: 'M4_COMMIT_HANDLE_SCOPE_MISMATCH',
  M4_COMMIT_HANDLE_CONFLICT: 'M4_COMMIT_HANDLE_CONFLICT',
  M4_COMMIT_HANDLE_REPLAYED: 'M4_COMMIT_HANDLE_REPLAYED',
  M4_COMMIT_INPUT_DRIFT: 'M4_COMMIT_INPUT_DRIFT',
  M4_COMMIT_WRITE_FAILED: 'M4_COMMIT_WRITE_FAILED',
  M4_COMMIT_VALIDATION_UNAVAILABLE: 'M4_COMMIT_VALIDATION_UNAVAILABLE',
  M4_COMMIT_VALIDATION_FAILED: 'M4_COMMIT_VALIDATION_FAILED',
  M4_COMMIT_ROLLBACK_FAILED: 'M4_COMMIT_ROLLBACK_FAILED',
});

function failure(code, violations, extra = {}) {
  return {
    ok: false,
    status: 'BLOCKED',
    code,
    violations: [...new Set((violations || []).map(String))],
    writesPerformed: 0,
    ...extra,
  };
}

function rawDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function secretDigest(secret) {
  return rawDigest(Buffer.from(secret));
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

function safeRelativePath(ref) {
  if (typeof ref !== 'string' || ref.length === 0 ||
      isAbsolute(ref) || ref.startsWith('/') ||
      ref.includes('\\') || ref.includes('\0') ||
      /[*?[\]{}]/.test(ref)) return false;
  return ref.split('/').every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..');
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function inspectTarget(root, ref) {
  if (!safeRelativePath(ref)) return null;
  try {
    let current = root;
    const segments = ref.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return null;
        if (index < segments.length - 1 && !stat.isDirectory()) return null;
        if (index === segments.length - 1 && !stat.isFile()) return null;
        if (!isInside(root, realpathSync(current))) return null;
      }
    }
    const target = resolve(root, ref);
    if (!isInside(root, target)) return null;
    if (!existsSync(target)) {
      return {
        target,
        exists: false,
        bytes: null,
        digest: null,
      };
    }
    const bytes = readFileSync(target);
    return {
      target,
      exists: true,
      bytes,
      digest: rawDigest(bytes),
    };
  } catch {
    return null;
  }
}

function deterministicDiff(file, before, after) {
  const beforeText = before === null ? '' : before.toString('utf8');
  const prefix = [
    `--- ${before === null ? '/dev/null' : `a/${file}`}`,
    `+++ b/${file}`,
    '@@ full-file @@',
  ];
  const removed = beforeText.split('\n')
    .filter((_, index, values) => index < values.length - 1)
    .map(line => `-${line}`);
  const added = after.split('\n')
    .filter((_, index, values) => index < values.length - 1)
    .map(line => `+${line}`);
  return `${[...prefix, ...removed, ...added].join('\n')}\n`;
}

function schemaValid(pluginRoot, schemaFile, value) {
  try {
    return validateSchema(pluginRoot, schemaFile, value).valid;
  } catch {
    return false;
  }
}

function makeBindingManifest(context, claimScope = 'IMPLEMENTED') {
  const plan = context.planningPreview.plan;
  const generatedById = new Map(
    context.preview.generatedTests.map(item => [item.caseId, item]),
  );
  const generatedTestDigests = Object.fromEntries(
    plan.cases.map(item => [item.caseId, generatedById.get(item.caseId).testDigest]),
  );
  const bindings = plan.cases.map(item => ({
    caseId: item.caseId,
    file: item.targetFile,
    title: item.title,
    fixtureDigest: item.fixtureDigest,
    assertionDigest: item.assertionDigest,
  }));
  const bindingUnsigned = {
    bindingId: `binding@${stableDigest({
      planDigest: plan.planDigest,
      generatedTestDigests,
      bindings,
    }).slice('sha256:'.length)}`,
    planDigest: plan.planDigest,
    generatedTestDigests,
    bindings,
    claimScope,
  };
  return {
    ...bindingUnsigned,
    bindingDigest: stableDigest(bindingUnsigned),
  };
}

function validationPlan(plan) {
  const files = plan.cases.map(item => item.targetFile);
  const isTypeScript = files.every(file => file.endsWith('.ts'));
  return [
    { kind: 'format', tool: 'prettier', args: ['--check', ...files] },
    ...(isTypeScript
      ? [{ kind: 'typecheck', tool: 'tsc', args: ['--noEmit', '--pretty', 'false', ...files] }]
      : files.map(file => ({ kind: 'syntax', tool: 'node', args: ['--check', file] }))),
    { kind: 'collect', tool: 'playwright', args: ['test', '--list', ...files] },
  ];
}

export function prepareImplementationCommitPreview(input = {}) {
  const { review } = input;
  const context = readTrustedCodeReviewContext(review);
  if (!context) {
    return failure(
      COMMIT_FAILURE_CODES.M4_COMMIT_REVIEW_UNTRUSTED,
      ['只接受 M4-C 同进程 PASS review'],
    );
  }
  const root = realpathSync(context.planningInput.projectRoot);
  const generatedById = new Map(
    context.preview.generatedTests.map(item => [item.caseId, item]),
  );
  // 按文件路径分组：同文件同内容允许去重，同文件不同内容拒绝
  const fileGroups = new Map();
  for (const item of context.preview.previews) {
    const existing = fileGroups.get(item.file);
    if (existing && existing.contentDigest !== item.contentDigest) {
      return failure(
        COMMIT_FAILURE_CODES.M4_COMMIT_DUPLICATE_TARGET,
        [`同路径不同内容:${item.file}`],
      );
    }
    if (!existing) {
      fileGroups.set(item.file, item);
    }
  }
  const plannedWrites = [];
  for (const [file, item] of fileGroups) {
    const inspected = inspectTarget(root, file);
    const generated = generatedById.get(item.caseId);
    if (!inspected ||
        rawDigest(Buffer.from(item.source, 'utf8')) !== item.contentDigest ||
        generated?.contentDigest !== item.contentDigest) {
      return failure(
        COMMIT_FAILURE_CODES.M4_COMMIT_TARGET_UNSAFE,
        [`目标路径或 source 摘要无效:${item.caseId}`],
      );
    }
    plannedWrites.push({
      caseId: item.caseId,
      file,
      change: inspected.exists ? 'update' : 'create',
      beforeDigest: inspected.digest,
      afterDigest: item.contentDigest,
      source: item.source,
      diff: deterministicDiff(file, inspected.bytes, item.source),
    });
  }
  const bindingManifest = makeBindingManifest(context);
  if (!schemaValid(context.pluginRoot, 'binding-manifest.json', bindingManifest)) {
    return failure(
      COMMIT_FAILURE_CODES.M4_COMMIT_PREVIEW_SCHEMA_INVALID,
      ['BindingManifest schema 无效'],
    );
  }
  const previewUnsigned = {
    contract: PREVIEW_CONTRACT,
    commitPreviewId: `commit-preview@${stableDigest({
      planDigest: context.planningPreview.plan.planDigest,
      reviewDigest: review.reviewDigest,
      writes: plannedWrites.map(item => ({
        file: item.file,
        beforeDigest: item.beforeDigest,
        afterDigest: item.afterDigest,
      })),
    }).slice('sha256:'.length)}`,
    planDigest: context.planningPreview.plan.planDigest,
    requestDigest: context.request.requestDigest,
    reviewDigest: review.reviewDigest,
    plannedWrites,
    bindingManifest,
    validationPlan: validationPlan(context.planningPreview.plan),
  };
  const commitPreview = deepFreeze({
    ...previewUnsigned,
    previewDigest: stableDigest(previewUnsigned),
  });
  if (!schemaValid(
    context.pluginRoot,
    'implementation-commit-preview.json',
    commitPreview,
  )) {
    return failure(
      COMMIT_FAILURE_CODES.M4_COMMIT_PREVIEW_SCHEMA_INVALID,
      ['ImplementationCommitPreview schema 无效'],
    );
  }
  TRUSTED_COMMIT_PREVIEWS.set(commitPreview, { context, root });
  return {
    ok: true,
    status: 'COMMIT_PREVIEW_READY',
    code: 'IMPLEMENTATION_COMMIT_PREVIEW_READY',
    commitPreview,
    writesPerformed: 0,
  };
}

function safeCompareHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function executableFor(root, tool) {
  if (tool === 'node') return process.execPath;
  const target = resolve(root, 'node_modules', '.bin', tool);
  try {
    if (!existsSync(target)) return null;
    const resolved = realpathSync(target);
    if (!isInside(root, resolved) || !statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function runValidations(root, plan, runner) {
  const results = [];
  for (const command of plan) {
    const executable = executableFor(root, command.tool);
    if (!executable) {
      return {
        ok: false,
        code: COMMIT_FAILURE_CODES.M4_COMMIT_VALIDATION_UNAVAILABLE,
        results,
        missingTool: command.tool,
      };
    }
    let run;
    try {
      run = runner(executable, command.args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH || '',
          CI: '1',
          NO_COLOR: '1',
        },
        shell: false,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      return {
        ok: false,
        code: COMMIT_FAILURE_CODES.M4_COMMIT_VALIDATION_FAILED,
        results,
        failedTool: command.tool,
        runnerErrorDigest: stableDigest({
          name: error?.name || 'Error',
          code: error?.code || null,
        }),
      };
    }
    const stdout = typeof run.stdout === 'string' ? run.stdout : '';
    const stderr = typeof run.stderr === 'string' ? run.stderr : '';
    const entry = {
      kind: command.kind,
      tool: command.tool,
      args: [...command.args],
      exitCode: Number.isInteger(run.status) ? run.status : -1,
      stdoutDigest: rawDigest(Buffer.from(stdout)),
      stderrDigest: rawDigest(Buffer.from(stderr)),
    };
    results.push(entry);
    if (entry.exitCode !== 0) {
      return {
        ok: false,
        code: COMMIT_FAILURE_CODES.M4_COMMIT_VALIDATION_FAILED,
        results,
        failedTool: command.tool,
      };
    }
  }
  return { ok: true, results };
}

function rollbackWrites(snapshots, createdDirs, handleId) {
  try {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.bytes === null) {
        rmSync(snapshot.target, { force: true });
      } else {
        const temp = `${snapshot.target}.${handleId}.rollback`;
        writeFileSync(temp, snapshot.bytes);
        chmodSync(temp, snapshot.mode);
        renameSync(temp, snapshot.target);
      }
    }
    for (const directory of [...createdDirs].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // 目录非空或已存在时不删除；文件字节恢复仍已完成。
      }
    }
    return true;
  } catch {
    return false;
  }
}

function writePlannedFiles(root, commitPreview, handleId) {
  const snapshots = [];
  const createdDirs = [];
  try {
    for (const planned of commitPreview.plannedWrites) {
      const inspected = inspectTarget(root, planned.file);
      if (!inspected || inspected.digest !== planned.beforeDigest) {
        return {
          ok: false,
          code: COMMIT_FAILURE_CODES.M4_COMMIT_TARGET_DRIFT,
          snapshots,
          createdDirs,
        };
      }
      const parent = dirname(inspected.target);
      const missing = [];
      let cursor = parent;
      while (!existsSync(cursor) && isInside(root, cursor)) {
        missing.push(cursor);
        cursor = dirname(cursor);
      }
      mkdirSync(parent, { recursive: true });
      createdDirs.push(...missing.reverse());
      const temp = `${inspected.target}.${handleId}.stage`;
      writeFileSync(temp, Buffer.from(planned.source, 'utf8'), { flag: 'wx' });
      chmodSync(temp, 0o600);
      snapshots.push({
        target: inspected.target,
        bytes: inspected.bytes,
        mode: inspected.exists ? statSync(inspected.target).mode & 0o777 : 0o644,
      });
      chmodSync(temp, inspected.exists
        ? statSync(inspected.target).mode & 0o777
        : 0o644);
      renameSync(temp, inspected.target);
    }
    return { ok: true, snapshots, createdDirs };
  } catch {
    const restored = rollbackWrites(snapshots, createdDirs, handleId);
    return {
      ok: false,
      code: restored
        ? COMMIT_FAILURE_CODES.M4_COMMIT_WRITE_FAILED
        : COMMIT_FAILURE_CODES.M4_COMMIT_ROLLBACK_FAILED,
      snapshots,
      createdDirs,
    };
  }
}

export function createImplementationCommitController(options = {}) {
  const {
    projectRoot,
    authoritySecret,
    keyId,
    clock = () => Date.now(),
    runner = spawnSync,
  } = options;
  if (typeof projectRoot !== 'string' ||
      !(authoritySecret instanceof Uint8Array) ||
      authoritySecret.byteLength < 32 ||
      typeof keyId !== 'string' ||
      keyId.length === 0 ||
      typeof clock !== 'function' ||
      typeof runner !== 'function') {
    throw new TypeError(COMMIT_FAILURE_CODES.M4_COMMIT_CONTROLLER_INVALID);
  }
  const root = realpathSync(projectRoot);
  const authorityKey = Buffer.from(authoritySecret);
  const projectDigest = stableDigest({ root });
  const records = new Map();

  function signatureFor(base) {
    return createHmac('sha256', authorityKey)
      .update(JSON.stringify(base))
      .digest('hex');
  }

  function writeSetDigest(commitPreview) {
    return stableDigest(commitPreview.plannedWrites.map(item => ({
      file: item.file,
      afterDigest: item.afterDigest,
    })));
  }

  function issue(commitPreview, { ttlMs = 300000 } = {}) {
    const registered = TRUSTED_COMMIT_PREVIEWS.get(commitPreview);
    const now = clock();
    if (!registered || registered.root !== root ||
        !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3600000 ||
        !Number.isFinite(now) || now < 0) {
      return failure(
        COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_SCOPE_MISMATCH,
        ['preview/controller/ttl 作用域不一致'],
      );
    }
    const authorizationSecret = randomBytes(32).toString('hex');
    const base = {
      contract: HANDLE_CONTRACT,
      handleId: `implement-handle@${randomBytes(16).toString('hex')}`,
      service: 'implement',
      projectDigest,
      planDigest: commitPreview.planDigest,
      previewDigest: commitPreview.previewDigest,
      writeSetDigest: writeSetDigest(commitPreview),
      issuedAt: now,
      expiry: now + ttlMs,
      oneTime: true,
      secretDigest: secretDigest(authorizationSecret),
    };
    const signature = {
      algorithm: 'HMAC-SHA256',
      keyId,
      mac: signatureFor(base),
    };
    const handleUnsigned = { ...base, signature };
    const handle = deepFreeze({
      ...handleUnsigned,
      handleDigest: stableDigest(handleUnsigned),
    });
    records.set(handle.handleId, {
      handle,
      commitPreview,
      authorizationSecretDigest: base.secretDigest,
      status: 'issued',
    });
    return deepFreeze({
      ok: true,
      status: 'HANDLE_ISSUED',
      code: 'IMPLEMENTATION_COMMIT_HANDLE_ISSUED',
      handle,
      authorizationSecret,
      writesPerformed: 0,
    });
  }

  function verifyHandle(record, handle, authorizationSecret, commitPreview) {
    if (!record ||
        !schemaValid(
          TRUSTED_COMMIT_PREVIEWS.get(commitPreview)?.context.pluginRoot,
          'implementation-commit-handle.json',
          handle,
        ) ||
        stableDigest(unsigned(handle, 'handleDigest')) !== handle.handleDigest) {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_INVALID;
    }
    const base = Object.fromEntries(
      Object.entries(handle).filter(([key]) =>
        key !== 'signature' && key !== 'handleDigest'),
    );
    if (handle.signature.keyId !== keyId ||
        !safeCompareHex(handle.signature.mac, signatureFor(base))) {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_INVALID;
    }
    if (record.status === 'consumed') {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_REPLAYED;
    }
    if (record.status === 'reserved') {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_CONFLICT;
    }
    const currentTime = clock();
    if (!Number.isFinite(currentTime) || currentTime >= handle.expiry) {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_EXPIRED;
    }
    const suppliedSecretDigest = secretDigest(authorizationSecret);
    if (!safeCompareHex(
      suppliedSecretDigest.slice('sha256:'.length),
      record.authorizationSecretDigest.slice('sha256:'.length),
    )) {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_SECRET_MISMATCH;
    }
    if (record.commitPreview !== commitPreview ||
        handle.projectDigest !== projectDigest ||
        handle.planDigest !== commitPreview.planDigest ||
        handle.previewDigest !== commitPreview.previewDigest ||
        handle.writeSetDigest !== writeSetDigest(commitPreview)) {
      return COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_SCOPE_MISMATCH;
    }
    return null;
  }

  function commit({ commitPreview, handle, authorizationSecret } = {}) {
    const registered = TRUSTED_COMMIT_PREVIEWS.get(commitPreview);
    const record = handle && records.get(handle.handleId);
    if (!registered || registered.root !== root) {
      return failure(
        COMMIT_FAILURE_CODES.M4_COMMIT_HANDLE_SCOPE_MISMATCH,
        ['commit preview 不属于当前 controller'],
      );
    }
    const handleFailure = verifyHandle(
      record,
      handle,
      authorizationSecret,
      commitPreview,
    );
    if (handleFailure) return failure(handleFailure, [handleFailure]);
    record.status = 'reserved';

    const currentPlan = prepareImplementationPlan(registered.context.planningInput);
    if (!currentPlan.ok ||
        currentPlan.plan.planDigest !== commitPreview.planDigest ||
        currentPlan.inputDigests.artifactContentDigest !==
          registered.context.planningPreview.inputDigests.artifactContentDigest ||
        currentPlan.inputDigests.matrixContentDigest !==
          registered.context.planningPreview.inputDigests.matrixContentDigest) {
      record.status = 'issued';
      return failure(
        COMMIT_FAILURE_CODES.M4_COMMIT_INPUT_DRIFT,
        [currentPlan.code || 'M4-A 输入链漂移'],
      );
    }
    for (const planned of commitPreview.plannedWrites) {
      const inspected = inspectTarget(root, planned.file);
      if (!inspected || inspected.digest !== planned.beforeDigest) {
        record.status = 'issued';
        return failure(
          COMMIT_FAILURE_CODES.M4_COMMIT_TARGET_DRIFT,
          [`目标文件漂移:${planned.file}`],
        );
      }
    }

    const writeResult = writePlannedFiles(root, commitPreview, handle.handleId);
    if (!writeResult.ok) {
      record.status = writeResult.code === COMMIT_FAILURE_CODES.M4_COMMIT_ROLLBACK_FAILED
        ? 'consumed'
        : 'issued';
      return failure(writeResult.code, [writeResult.code]);
    }
    const validation = runValidations(root, commitPreview.validationPlan, runner);
    const validationUnsigned = {
      planDigest: commitPreview.planDigest,
      previewDigest: commitPreview.previewDigest,
      results: validation.results,
      passed: validation.ok,
    };
    const validationReceipt = {
      ...validationUnsigned,
      receiptDigest: stableDigest(validationUnsigned),
    };
    if (!validation.ok) {
      const restored = rollbackWrites(
        writeResult.snapshots,
        writeResult.createdDirs,
        handle.handleId,
      );
      record.status = restored ? 'issued' : 'consumed';
      return failure(
        restored ? validation.code : COMMIT_FAILURE_CODES.M4_COMMIT_ROLLBACK_FAILED,
        [validation.missingTool || validation.failedTool || validation.code],
        { validationReceipt },
      );
    }
    record.status = 'consumed';
    const bindingUnsigned = {
      ...unsigned(commitPreview.bindingManifest, 'bindingDigest'),
      claimScope: 'READY_TO_RUN',
    };
    const readyBindingManifest = {
      ...bindingUnsigned,
      bindingDigest: stableDigest(bindingUnsigned),
    };
    const committed = deepFreeze({
      ok: true,
      status: 'READY_TO_RUN',
      code: 'IMPLEMENTATION_COMMIT_READY_TO_RUN',
      bindingManifest: deepFreeze(readyBindingManifest),
      validationReceipt: deepFreeze(validationReceipt),
      writesPerformed: commitPreview.plannedWrites.length,
      claimScope: 'READY_TO_RUN',
    });
    TRUSTED_COMMIT_RESULTS.set(committed, {
      commitPreview,
      context: registered.context,
      root,
    });
    return committed;
  }

  return Object.freeze({ issue, commit });
}

export function readTrustedImplementationCommitContext(commitResult) {
  const context = commitResult && TRUSTED_COMMIT_RESULTS.get(commitResult);
  if (!context ||
      commitResult.ok !== true ||
      commitResult.status !== 'READY_TO_RUN' ||
      commitResult.bindingManifest?.claimScope !== 'READY_TO_RUN') {
    return null;
  }
  return Object.freeze({ ...context, commitResult });
}
