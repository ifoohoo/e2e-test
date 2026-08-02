/**
 * capability-catalog-loader.mjs
 *
 * 单一能力目录加载器。
 * help/setup/quickstart 必须通过此加载器读取同一目录文件，
 * 不得各自维护服务数组、版本、依赖、权限或状态副本。
 *
 * 设计约束：
 * - 确定性：不添加时间戳、随机 ID 或进程相关数据
 * - 只读：不写入任何文件
 * - 交叉验证：版本从 package.json 和 descriptor 交叉验证
 * - exact-shape：schema 校验使用 additionalProperties:false
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { default as Ajv } from '../runtime-deps/ajv-bundle.mjs';
import { stableDigest } from './digest.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', '..');

// ─── 浏览器服务冻结入口映射 ───
const BROWSER_ENTRYPOINT_MAP = Object.freeze({
  'artifact.e2e-test.browser.implement': 'skills/e2e-test-implement',
  'artifact.e2e-test.browser.execute': 'skills/e2e-test-execute',
});

// ─── Schema validation ───
let _ajvInstance = null;
const _validators = new Map();

function getAjv() {
  if (!_ajvInstance) {
    try {
      _ajvInstance = new Ajv({ allErrors: true, strict: false });
    } catch {
      return null;
    }
  }
  return _ajvInstance;
}

function getValidator(schemaPath) {
  if (_validators.has(schemaPath)) return _validators.get(schemaPath);
  const ajv = getAjv();
  if (!ajv) return null;
  try {
    if (!existsSync(schemaPath)) return null;
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    _validators.set(schemaPath, validate);
    return validate;
  } catch {
    return null;
  }
}

/**
 * 加载并验证能力目录。
 * @param {string} [root] - 插件根目录，默认自动检测
 * @returns {{ catalog: object, digest: string, errors: string[] }}
 */
export function loadCapabilityCatalog(root) {
  const effectiveRoot = root || pluginRoot;
  const catalogPath = join(effectiveRoot, 'assets', 'capability-catalog.json');
  const schemaPath = join(effectiveRoot, 'schemas', 'capability-catalog.json');
  const errors = [];

  if (!existsSync(catalogPath)) {
    return { catalog: null, digest: null, errors: ['CATALOG_FILE_MISSING'] };
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    return { catalog: null, digest: null, errors: ['CATALOG_PARSE_ERROR'] };
  }

  // Schema validation
  const validate = getValidator(schemaPath);
  if (validate) {
    const valid = validate(catalog);
    if (!valid) {
      for (const err of validate.errors || []) {
        errors.push(`SCHEMA_INVALID: ${err.instancePath} ${err.message}`);
      }
    }
  } else {
    errors.push('SCHEMA_VALIDATOR_UNAVAILABLE');
  }

  // Cross-validate version with package.json
  const pkgPath = join(effectiveRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (catalog.packageVersion !== pkg.version) {
        errors.push(`VERSION_MISMATCH: catalog=${catalog.packageVersion} package=${pkg.version}`);
      }
    } catch {
      errors.push('PACKAGE_JSON_UNREADABLE');
    }
  }

  // Cross-validate version with descriptor
  const descriptorPath = join(effectiveRoot, 'family', 'implementation.yaml');
  if (existsSync(descriptorPath)) {
    try {
      const descriptorText = readFileSync(descriptorPath, 'utf8');
      const descVersion = descriptorText.match(/^\s*version:\s*(.+)$/m)?.[1]?.trim();
      if (descVersion && catalog.packageVersion !== descVersion) {
        errors.push(`DESCRIPTOR_VERSION_MISMATCH: catalog=${catalog.packageVersion} descriptor=${descVersion}`);
      }
    } catch {
      errors.push('DESCRIPTOR_UNREADABLE');
    }
  }

  // Validate available capability entryPoint（使用共享 validator）
  errors.push(...validateCatalogEntryPoints(catalog, effectiveRoot));

  // Compute digest of catalog (excluding generatedAt which is deterministic placeholder)
  const catalogForDigest = { ...catalog };
  delete catalogForDigest.generatedAt;
  const digest = stableDigest(catalogForDigest);

  return { catalog, digest, errors };
}

/**
 * 验证 available 能力的 entryPoint 有效性。
 * 独立于 loadCapabilityCatalog，不阻塞目录加载。
 * @param {object} catalog - 目录对象
 * @param {string} [root] - 插件根目录
 * @returns {string[]} 错误列表
 */
export function validateCatalogEntryPoints(catalog, root) {
  const effectiveRoot = root || pluginRoot;
  const errors = [];
  if (!catalog?.capabilities) return errors;
  for (const cap of catalog.capabilities) {
    if (cap.status !== 'available' || !cap.entryPoint) continue;
    const ep = cap.entryPoint;

    // N/A_PLANNED 保持失败关闭
    if (ep === 'N/A_PLANNED') {
      errors.push(`ENTRYPOINT_NA_PLANNED: ${cap.id} 状态为 available 但 entryPoint 为 N/A_PLANNED`);
      continue;
    }

    // 绝对路径
    if (isAbsolute(ep)) {
      errors.push(`ENTRYPOINT_ABSOLUTE: ${cap.id} entryPoint 是绝对路径`);
      continue;
    }

    // 路径遍历
    if (ep.includes('..')) {
      errors.push(`ENTRYPOINT_TRAVERSAL: ${cap.id} entryPoint 包含 ..`);
      continue;
    }

    // 不存在
    const epPath = join(effectiveRoot, ep);
    if (!existsSync(epPath)) {
      errors.push(`ENTRYPOINT_NOT_FOUND: ${cap.id} entryPoint 不存在: ${ep}`);
      continue;
    }

    // browser 服务额外检查
    const isBrowser = cap.id === 'artifact.e2e-test.browser.implement'
      || cap.id === 'artifact.e2e-test.browser.execute';
    if (isBrowser) {
      const expectedEp = BROWSER_ENTRYPOINT_MAP[cap.id];
      if (expectedEp && ep !== expectedEp) {
        errors.push(`BROWSER_ENTRYPOINT_MISMATCH: ${cap.id} entryPoint 不匹配冻结映射：期望 ${expectedEp}，实际 ${ep}`);
        continue;
      }
      // 检查是否为目录（包含无法访问的情况）
      let isDir = false;
      try {
        isDir = statSync(epPath).isDirectory();
      } catch {
        // statSync 失败，视为不是目录
      }
      if (!isDir) {
        errors.push(`BROWSER_ENTRYPOINT_TYPE_MISMATCH: ${cap.id} entryPoint 不是目录: ${ep}`);
      }
    }
  }
  return errors;
}

/**
 * 从目录中获取能力列表，可选按类型和状态过滤。
 * @param {object} catalog - 目录对象
 * @param {{ type?: string, status?: string }} [filter]
 * @returns {object[]}
 */
export function getCapabilities(catalog, filter) {
  if (!catalog?.capabilities) return [];
  let caps = catalog.capabilities;
  if (filter?.type) caps = caps.filter(c => c.type === filter.type);
  if (filter?.status) caps = caps.filter(c => c.status === filter.status);
  return caps;
}

/**
 * 获取当前可用的能力（status=available）。
 */
export function getAvailableCapabilities(catalog) {
  return getCapabilities(catalog, { status: 'available' });
}

/**
 * 获取计划中的能力（status=planned）。
 */
export function getPlannedCapabilities(catalog) {
  return getCapabilities(catalog, { status: 'planned' });
}

/**
 * 获取内部阶段能力（status=internal）。
 */
export function getInternalCapabilities(catalog) {
  return getCapabilities(catalog, { status: 'internal' });
}

/**
 * 获取 adoption-shell 类型的能力。
 */
export function getAdoptionShellCapabilities(catalog) {
  return getCapabilities(catalog, { type: 'adoption-shell' });
}

/**
 * 获取 spec-kernel 类型的能力。
 */
export function getSpecKernelCapabilities(catalog) {
  return getCapabilities(catalog, { type: 'spec-kernel' });
}

/**
 * 获取 browser-extension 类型的能力。
 */
export function getBrowserExtensionCapabilities(catalog) {
  return getCapabilities(catalog, { type: 'browser-extension' });
}

/**
 * 按 id 查找能力。
 */
export function findCapability(catalog, id) {
  if (!catalog?.capabilities) return null;
  return catalog.capabilities.find(c => c.id === id) || null;
}

/**
 * 检查能力是否为当前可调用（available）。
 */
export function isCallable(catalog, id) {
  const cap = findCapability(catalog, id);
  return cap?.status === 'available';
}

/**
 * 目录投影：为 help 输出生成能力摘要。
 * 不手写 capabilities 数组，从目录投影。
 */
export function projectCapabilitiesForHelp(catalog) {
  if (!catalog) return [];
  return catalog.capabilities
    .filter(c => c.type !== 'internal-stage')
    .map(c => ({
      id: c.id,
      type: c.type,
      status: c.status,
      description: c.description,
      permissions: { ...c.permissions },
      callable: c.status === 'available',
    }));
}
