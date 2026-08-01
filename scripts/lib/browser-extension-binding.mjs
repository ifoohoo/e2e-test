/**
 * browser-extension-binding.mjs
 *
 * ExtensionBinding 验证模块。
 * 单次与 session 模式共享同一个 production validator，不复制两套判断。
 *
 * 验证顺序（必须在任何副作用前）：
 * 0. 公开 JSON Schema 验证（字段、类型、格式、additionalProperties）
 * 1. recordId 存在
 * 2. 未知字段拒绝（exact-shape）
 * 3. bindingDigest 自摘要验证
 * 4. packageVersion 与当前候选一致
 * 5. extensionContractRevision 与冻结合同一致
 * 6. permissionSnapshot 逐类验证
 * 7. scope.project 与请求 projectRoot 一致
 * 8. scope.subject 验证（可选，implement/execute 各有不同）
 * 9. scope.allowWritePaths 验证（可选）
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableDigest } from './digest.mjs';
import { validateSchema } from './schema-validation.mjs';

const EXTENSION_CONTRACT_REVISION = 'e2e-test/browser-productization-delta@4';

const CANDIDATE_ROOT = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../..',
);

const IMPLEMENT_PERMISSIONS = Object.freeze({
  sourceWrite: true,
  artifactWrite: true,
  verifyCommand: true,
  testCommand: false,
  processLifecycle: false,
  networkEgress: false,
});

const EXECUTE_PERMISSIONS = Object.freeze({
  sourceWrite: false,
  artifactWrite: true,
  verifyCommand: false,
  testCommand: true,
  processLifecycle: true,
  networkEgress: true,
});

const KNOWN_BINDING_FIELDS = new Set([
  'recordId',
  'extensionId',
  'service',
  'boundBy',
  'boundAt',
  'scope',
  'enabled',
  'status',
  'extensionContractRevision',
  'packageVersion',
  'permissionSnapshot',
  'bindingDigest',
]);

const REQUIRED_BINDING_FIELDS = [
  'recordId',
  'extensionId',
  'service',
  'boundBy',
  'boundAt',
  'scope',
  'enabled',
  'status',
  'extensionContractRevision',
  'packageVersion',
  'permissionSnapshot',
  'bindingDigest',
];

const KNOWN_SCOPE_FIELDS = new Set(['project', 'subject', 'allowWritePaths']);

const PERMISSION_CATEGORIES = [
  'sourceWrite',
  'artifactWrite',
  'verifyCommand',
  'testCommand',
  'processLifecycle',
  'networkEgress',
];

/**
 * 基于公开 extension-binding.json schema（Ajv + ajv-formats）验证 binding 结构。
 * 返回 null 表示 schema 合法；返回错误对象表示 schema 非法。
 * Ajv errors 确定性映射到 M2 冻结错误码，无法映射的返回 BINDING_SCHEMA_INVALID。
 * @param {object} binding
 * @returns {{ ok: false, code: string, violations: string[] } | null}
 */
function validateAgainstSchema(binding) {
  let result;
  try {
    result = validateSchema(CANDIDATE_ROOT, 'extension-binding.json', binding);
  } catch {
    return {
      ok: false,
      code: 'BINDING_SCHEMA_UNAVAILABLE',
      violations: ['无法加载或编译 extension-binding.json schema'],
    };
  }

  if (result.valid) return null;

  // 确定性映射 Ajv errors 到 M2 冻结错误码
  for (const err of result.errors) {
    // required → 缺少必填字段
    if (err.keyword === 'required') {
      const field = err.params.missingProperty;
      switch (field) {
        case 'recordId':
          return { ok: false, code: 'BINDING_NO_RECORD_ID', violations: [`缺少必填字段：${field}`] };
        case 'extensionId':
          return { ok: false, code: 'BINDING_NO_EXTENSION_ID', violations: [`缺少必填字段：${field}`] };
        case 'service':
          return { ok: false, code: 'BINDING_NO_SERVICE', violations: [`缺少必填字段：${field}`] };
        case 'extensionContractRevision':
          return { ok: false, code: 'BINDING_NO_CONTRACT_REVISION', violations: [`缺少必填字段：${field}`] };
        case 'packageVersion':
          return { ok: false, code: 'BINDING_NO_PACKAGE_VERSION', violations: [`缺少必填字段：${field}`] };
        case 'permissionSnapshot':
          return { ok: false, code: 'BINDING_NO_PERMISSION_SNAPSHOT', violations: [`缺少必填字段：${field}`] };
        default:
          return { ok: false, code: `BINDING_REQUIRED_FIELD_MISSING:${field}`, violations: [`缺少必填字段：${field}`] };
      }
    }

    // additionalProperties → 未知字段（顶层、scope、permissionSnapshot）
    if (err.keyword === 'additionalProperties') {
      return { ok: false, code: 'BINDING_UNKNOWN_FIELDS', violations: [`未知字段：${err.params.additionalProperty}`] };
    }

    // const → extensionId 或 extensionContractRevision 不匹配
    if (err.keyword === 'const') {
      if (err.instancePath === '/extensionId') {
        return { ok: false, code: 'BINDING_EXTENSION_MISMATCH', violations: [`extensionId 不匹配：期望 ${err.params.allowedValue}`] };
      }
      if (err.instancePath === '/extensionContractRevision') {
        return { ok: false, code: 'BINDING_CONTRACT_REVISION_MISMATCH', violations: [`extensionContractRevision 不匹配：期望 ${err.params.allowedValue}`] };
      }
    }

    // type + permissionSnapshot 子字段 → 权限类别非布尔
    if (err.keyword === 'type' && err.instancePath.startsWith('/permissionSnapshot/')) {
      const cat = err.instancePath.split('/')[2];
      return { ok: false, code: `BINDING_PERMISSION_SNAPSHOT_BAD:${cat}`, violations: [`permissionSnapshot.${cat} 非布尔值`] };
    }
  }

  // 无法映射到 M2 冻结错误码的 schema 违规（boundBy 对象、boundAt 非 date-time、scope 嵌套类型等）
  const violations = result.errors.map(e => `${e.instancePath || '/'}: ${e.message}`);
  return { ok: false, code: 'BINDING_SCHEMA_INVALID', violations };
}

/**
 * 验证 ExtensionBinding。
 * @param {object} binding - 绑定对象
 * @param {object} options
 * @param {string} [options.expectedService] - 期望的完整 service identity（跨服务检查）
 * @param {string} options.projectRoot - 请求中的 projectRoot（已解析真实路径）
 * @param {string} options.packageVersion - 当前候选包版本
 * @param {string} [options.expectedSubject] - 期望的 scope.subject（implement 为 plan digest，execute 为 binding digest）
 * @param {string[]} [options.expectedWritePaths] - 期望的 scope.allowWritePaths（规范化排序后比较）
 * @returns {{ ok: true } | { ok: false, code: string, violations: string[] }}
 */
export function validateExtensionBinding(binding, options) {
  const { expectedService, projectRoot, packageVersion, expectedSubject, expectedWritePaths } = options;

  // 0. 公开 JSON Schema 验证（字段、类型、格式、additionalProperties）
  const schemaResult = validateAgainstSchema(binding);
  if (schemaResult) return schemaResult;

  // 1. recordId 存在且非空（特殊错误码，保持向后兼容）
  if (!binding.recordId || typeof binding.recordId !== 'string' || binding.recordId.length === 0) {
    return { ok: false, code: 'BINDING_NO_RECORD_ID', violations: ['ExtensionBinding 缺少 recordId'] };
  }

  // 1a. M2 冻结精确错误码（在其余必填字段检查前）
  if (binding.extensionId === undefined || binding.extensionId === null) {
    return { ok: false, code: 'BINDING_NO_EXTENSION_ID', violations: ['ExtensionBinding 缺少 extensionId'] };
  }
  if (typeof binding.extensionId !== 'string' || binding.extensionId !== 'artifact.e2e-test.browser') {
    return { ok: false, code: 'BINDING_EXTENSION_MISMATCH', violations: [`extensionId 不匹配：期望 artifact.e2e-test.browser，实际 ${binding.extensionId}`] };
  }
  if (binding.service === undefined || binding.service === null) {
    return { ok: false, code: 'BINDING_NO_SERVICE', violations: ['ExtensionBinding 缺少 service'] };
  }
  if (expectedService && binding.service !== expectedService) {
    return { ok: false, code: 'BINDING_SERVICE_MISMATCH', violations: [`binding.service 不匹配：需要 ${expectedService}，实际 ${binding.service}`] };
  }
  // status/enabled 一致性检查（M2 冻结错误码，必须在单独检查前）
  const activeByStatus = binding.status === 'active';
  const activeByEnabled = binding.enabled === true;
  if (activeByStatus !== activeByEnabled) {
    return { ok: false, code: 'BINDING_STATUS_ENABLED_MISMATCH', violations: ['status/enabled 不一致'] };
  }
  if (binding.enabled !== true) {
    return { ok: false, code: 'BINDING_NOT_ENABLED', violations: ['ExtensionBinding 未启用（enabled !== true）'] };
  }
  if (binding.status !== 'active') {
    return { ok: false, code: 'BINDING_REVOKED', violations: ['ExtensionBinding 已撤销（status !== active）'] };
  }
  if (binding.extensionContractRevision === undefined || binding.extensionContractRevision === null) {
    return { ok: false, code: 'BINDING_NO_CONTRACT_REVISION', violations: ['ExtensionBinding 缺少 extensionContractRevision'] };
  }
  if (binding.packageVersion === undefined || binding.packageVersion === null) {
    return { ok: false, code: 'BINDING_NO_PACKAGE_VERSION', violations: ['ExtensionBinding 缺少 packageVersion'] };
  }
  if (binding.permissionSnapshot === undefined || binding.permissionSnapshot === null) {
    return { ok: false, code: 'BINDING_NO_PERMISSION_SNAPSHOT', violations: ['ExtensionBinding 缺少 permissionSnapshot'] };
  }

  // 1b. 其他必填字段缺失检查（在未知字段检查前）
  for (const field of REQUIRED_BINDING_FIELDS) {
    if (field === 'recordId') continue; // 已在上一步检查
    if (['extensionId', 'service', 'extensionContractRevision', 'packageVersion', 'permissionSnapshot'].includes(field)) continue; // 已有精确错误码
    if (binding[field] === undefined || binding[field] === null) {
      return {
        ok: false,
        code: `BINDING_REQUIRED_FIELD_MISSING:${field}`,
        violations: [`ExtensionBinding 缺少必填字段：${field}`],
      };
    }
  }

  // 2. 顶层未知字段拒绝（exact-shape）
  const unknownFields = Object.keys(binding).filter(k => !KNOWN_BINDING_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      code: 'BINDING_UNKNOWN_FIELDS',
      violations: [`ExtensionBinding 包含未知字段：${unknownFields.join(', ')}`],
    };
  }

  // 2a. scope 未知字段拒绝（exact-shape）
  if (binding.scope && typeof binding.scope === 'object') {
    const scopeUnknownFields = Object.keys(binding.scope).filter(k => !KNOWN_SCOPE_FIELDS.has(k));
    if (scopeUnknownFields.length > 0) {
      return {
        ok: false,
        code: 'BINDING_UNKNOWN_FIELDS',
        violations: [`ExtensionBinding scope 包含未知字段：${scopeUnknownFields.join(', ')}`],
      };
    }
  }

  // 2b. permissionSnapshot 未知字段拒绝（exact-shape）
  if (binding.permissionSnapshot && typeof binding.permissionSnapshot === 'object') {
    const permUnknownFields = Object.keys(binding.permissionSnapshot).filter(k => !PERMISSION_CATEGORIES.includes(k));
    if (permUnknownFields.length > 0) {
      return {
        ok: false,
        code: 'BINDING_UNKNOWN_FIELDS',
        violations: [`ExtensionBinding permissionSnapshot 包含未知字段：${permUnknownFields.join(', ')}`],
      };
    }
  }

  // 3. bindingDigest 自摘要验证
  if (typeof binding.bindingDigest !== 'string') {
    return { ok: false, code: 'BINDING_DIGEST_MISMATCH', violations: ['ExtensionBinding 缺少 bindingDigest'] };
  }
  const unsigned = { ...binding };
  delete unsigned.bindingDigest;
  const computedDigest = stableDigest(unsigned);
  if (computedDigest !== binding.bindingDigest) {
    return { ok: false, code: 'BINDING_DIGEST_MISMATCH', violations: ['bindingDigest 自摘要不匹配'] };
  }

  // 4. packageVersion 与当前候选一致
  if (binding.packageVersion !== packageVersion) {
    return {
      ok: false,
      code: 'BINDING_PACKAGE_VERSION_MISMATCH',
      violations: [`packageVersion 不匹配：期望 ${packageVersion}，实际 ${binding.packageVersion}`],
    };
  }

  // 5. extensionContractRevision 与冻结合同一致
  if (binding.extensionContractRevision !== EXTENSION_CONTRACT_REVISION) {
    return {
      ok: false,
      code: 'BINDING_CONTRACT_REVISION_MISMATCH',
      violations: [`extensionContractRevision 不匹配：期望 ${EXTENSION_CONTRACT_REVISION}，实际 ${binding.extensionContractRevision}`],
    };
  }

  // 6. permissionSnapshot 逐类验证
  const isImplement = binding.service?.endsWith('.implement');
  const expectedPerms = isImplement ? IMPLEMENT_PERMISSIONS : EXECUTE_PERMISSIONS;
  if (!binding.permissionSnapshot || typeof binding.permissionSnapshot !== 'object') {
    return { ok: false, code: 'BINDING_NO_PERMISSION_SNAPSHOT', violations: ['permissionSnapshot 缺失'] };
  }
  for (const cat of PERMISSION_CATEGORIES) {
    if (typeof binding.permissionSnapshot[cat] !== 'boolean') {
      return {
        ok: false,
        code: `BINDING_PERMISSION_SNAPSHOT_BAD:${cat}`,
        violations: [`permissionSnapshot.${cat} 非布尔值：${typeof binding.permissionSnapshot[cat]}`],
      };
    }
    if (binding.permissionSnapshot[cat] !== expectedPerms[cat]) {
      return {
        ok: false,
        code: `BINDING_PERMISSION_SNAPSHOT_MISMATCH:${cat}`,
        violations: [`permissionSnapshot.${cat} 不匹配：期望 ${expectedPerms[cat]}，实际 ${binding.permissionSnapshot[cat]}`],
      };
    }
  }

  // 7. scope.project 与请求 projectRoot 一致（两边都解析真实路径以处理 symlink）
  if (!binding.scope || typeof binding.scope !== 'object') {
    return { ok: false, code: 'BINDING_SCOPE_PROJECT_MISMATCH', violations: ['scope 缺失'] };
  }
  let resolvedScopeProject;
  try {
    resolvedScopeProject = realpathSync(binding.scope.project);
  } catch {
    return {
      ok: false,
      code: 'BINDING_SCOPE_PROJECT_MISMATCH',
      violations: [`scope.project 无法解析：${binding.scope.project}`],
    };
  }
  if (resolvedScopeProject !== projectRoot) {
    return {
      ok: false,
      code: 'BINDING_SCOPE_PROJECT_MISMATCH',
      violations: [`scope.project 不匹配：期望 ${projectRoot}，实际 ${binding.scope.project}`],
    };
  }

  // 8. scope.subject 验证（可选）
  if (expectedSubject !== undefined) {
    if (binding.scope.subject !== expectedSubject) {
      return {
        ok: false,
        code: 'BINDING_SCOPE_SUBJECT_MISMATCH',
        violations: [`scope.subject 不匹配：期望 ${expectedSubject}，实际 ${binding.scope.subject}`],
      };
    }
  }

  // 9. scope.allowWritePaths 验证（可选）
  if (expectedWritePaths !== undefined) {
    const actualPaths = [...(binding.scope.allowWritePaths || [])].sort();
    const expectedSorted = [...expectedWritePaths].sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedSorted)) {
      return {
        ok: false,
        code: 'BINDING_WRITE_SET_MISMATCH',
        violations: [`scope.allowWritePaths 不匹配：期望 ${JSON.stringify(expectedSorted)}，实际 ${JSON.stringify(actualPaths)}`],
      };
    }
  }

  return { ok: true };
}

/**
 * 获取服务对应的冻结权限矩阵。
 */
export function getExpectedPermissions(service) {
  return service?.endsWith('.implement') ? IMPLEMENT_PERMISSIONS : EXECUTE_PERMISSIONS;
}

export { EXTENSION_CONTRACT_REVISION, IMPLEMENT_PERMISSIONS, EXECUTE_PERMISSIONS };
