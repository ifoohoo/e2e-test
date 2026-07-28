/**
 * setup-shell.mjs
 *
 * E2E Test setup 采用外壳。
 * 不是 Authority API service；默认全只读。
 *
 * 模式：
 * - check：只读检查 package/peer dependencies、能力目录和项目根可读性
 * - profile：调用 ProjectProfile detector，返回只读画像
 * - plan：基于当前事实返回稳定计划和摘要
 * - apply --accept-plan <digest>：仅允许执行同一冻结计划的精确 write set
 * - doctor：只读复核当前状态和漂移
 *
 * M3 写入边界：
 * - 六类常规权限全部为 false
 * - apply 无合法写入目标时返回 SETUP_APPLY_NOT_AVAILABLE，零写入
 * - 不运行 start/build/test，不调用包管理器安装，不联网，不下载浏览器
 * - 输出不得包含环境变量值、secret 或绝对本机路径泄漏
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCapabilityCatalog, getAvailableCapabilities, getPlannedCapabilities } from './capability-catalog-loader.mjs';
import { stableDigest } from './digest.mjs';

/**
 * setup check：只读检查 package/peer dependencies、能力目录和项目根可读性。
 * @param {string} projectRoot - 项目根目录
 * @param {string} [pluginRoot] - 插件根目录
 * @returns {object} 结构化检查结果
 */
export function setupCheck(projectRoot, pluginRoot) {
  const effectivePluginRoot = pluginRoot || resolve(import.meta.dirname, '..', '..');
  const result = {
    mode: 'check',
    status: 'OK',
    projectRoot: projectRoot || null,
    checks: [],
    writable: false,
  };

  // 1. 项目根可读性
  if (!projectRoot) {
    result.checks.push({ name: 'projectRoot', status: 'MISSING', message: '未提供项目根目录' });
    result.status = 'WARN';
  } else if (!existsSync(projectRoot)) {
    result.checks.push({ name: 'projectRoot', status: 'NOT_FOUND', message: '项目根目录不存在' });
    result.status = 'FAIL';
  } else {
    try {
      statSync(projectRoot);
      result.checks.push({ name: 'projectRoot', status: 'OK', message: '项目根目录可读' });
    } catch {
      result.checks.push({ name: 'projectRoot', status: 'UNREADABLE', message: '项目根目录不可读' });
      result.status = 'FAIL';
    }
  }

  // 2. 能力目录
  const { catalog, digest, errors } = loadCapabilityCatalog(effectivePluginRoot);
  if (!catalog) {
    result.checks.push({ name: 'capabilityCatalog', status: 'MISSING', message: '能力目录文件不存在或解析失败' });
    result.status = 'FAIL';
  } else if (errors.length > 0) {
    result.checks.push({ name: 'capabilityCatalog', status: 'WARN', message: `能力目录有 ${errors.length} 个警告`, errors });
    if (result.status !== 'FAIL') result.status = 'WARN';
  } else {
    result.checks.push({ name: 'capabilityCatalog', status: 'OK', message: '能力目录加载并验证通过', digest });
  }

  // 3. package.json
  const pkgPath = join(effectivePluginRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      result.checks.push({
        name: 'package',
        status: 'OK',
        version: pkg.version,
        name: pkg.name,
      });
    } catch {
      result.checks.push({ name: 'package', status: 'UNREADABLE', message: 'package.json 解析失败' });
    }
  } else {
    result.checks.push({ name: 'package', status: 'MISSING', message: 'package.json 不存在' });
  }

  // 4. descriptor
  const descriptorPath = join(effectivePluginRoot, 'family', 'implementation.yaml');
  if (existsSync(descriptorPath)) {
    try {
      const text = readFileSync(descriptorPath, 'utf8');
      const version = text.match(/^\s*version:\s*(.+)$/m)?.[1]?.trim();
      result.checks.push({ name: 'descriptor', status: 'OK', version });
    } catch {
      result.checks.push({ name: 'descriptor', status: 'UNREADABLE', message: 'implementation.yaml 解析失败' });
    }
  } else {
    result.checks.push({ name: 'descriptor', status: 'MISSING', message: 'implementation.yaml 不存在' });
  }

  // 5. Authority API 存在性（只读检查，不修改）
  const apiPath = join(effectivePluginRoot, 'authority-api', 'api.json');
  if (existsSync(apiPath)) {
    result.checks.push({ name: 'authorityApi', status: 'OK', message: 'Authority API 快照存在' });
  } else {
    result.checks.push({ name: 'authorityApi', status: 'MISSING', message: 'Authority API 快照不存在' });
  }

  result.writable = false; // M3: setup 全只读
  return result;
}

/**
 * setup profile：调用 ProjectProfile detector，返回只读画像。
 * @param {string} projectRoot
 * @param {{ startCommand?: object, baseURL?: string, readinessURL?: string }} [explicitFacts]
 * @param {string} [pluginRoot]
 * @returns {object}
 */
export async function setupProfile(projectRoot, explicitFacts, pluginRoot) {
  const effectivePluginRoot = pluginRoot || resolve(import.meta.dirname, '..', '..');
  // 动态导入 detector 避免循环依赖
  const { detectProjectProfile } = await import('./project-profile-detector.mjs');
  return detectProjectProfile(projectRoot, explicitFacts, effectivePluginRoot);
}

/**
 * setup plan：基于当前事实返回稳定计划和摘要。
 * M3 无合法写入目标，writeSet 必须为空。
 * @param {string} projectRoot
 * @param {string} [pluginRoot]
 * @returns {object}
 */
export function setupPlan(projectRoot, pluginRoot) {
  const effectivePluginRoot = pluginRoot || resolve(import.meta.dirname, '..', '..');
  const { catalog, digest: catalogDigest, errors } = loadCapabilityCatalog(effectivePluginRoot);

  const plan = {
    mode: 'plan',
    status: 'NO_APPLICABLE_CHANGES',
    projectRoot: projectRoot || null,
    catalogDigest: catalogDigest || null,
    catalogErrors: errors,
    writeSet: [],
    steps: [],
    note: 'M3 无合法写入目标；setup apply 不可用。能力目录、配置和项目文件均为只读。',
  };

  if (catalog) {
    const available = getAvailableCapabilities(catalog);
    const planned = getPlannedCapabilities(catalog);
    plan.steps.push({
      action: 'report-capabilities',
      description: `当前可用能力 ${available.length} 项，计划中能力 ${planned.length} 项`,
      available: available.map(c => c.id),
      planned: planned.map(c => c.id),
    });
  }

  // M3: 无写入目标
  plan.writeSet = [];
  return plan;
}

/**
 * setup apply：M3 无合法写入目标，明确失败关闭且零写入。
 * @param {string} planDigest - 计划摘要
 * @param {string} [pluginRoot]
 * @returns {object}
 */
export function setupApply(planDigest, pluginRoot) {
  // M3 没有由 accepted contract 明确定义、且当前能力真实需要的项目配置写入目标
  return {
    mode: 'apply',
    status: 'SETUP_APPLY_NOT_AVAILABLE',
    planDigest: planDigest || null,
    writeSet: [],
    written: [],
    note: 'M3 无合法写入目标。setup apply 不执行任何写入操作。',
  };
}

/**
 * setup doctor：只读复核当前状态和漂移。
 * @param {string} projectRoot
 * @param {string} [pluginRoot]
 * @returns {object}
 */
export function setupDoctor(projectRoot, pluginRoot) {
  const effectivePluginRoot = pluginRoot || resolve(import.meta.dirname, '..', '..');

  // 先执行 check
  const checkResult = setupCheck(projectRoot, effectivePluginRoot);

  // 额外漂移检查
  const driftChecks = [];
  const { catalog, digest, errors } = loadCapabilityCatalog(effectivePluginRoot);

  if (catalog) {
    // 检查 planned 能力是否被错误标记为 available
    for (const cap of catalog.capabilities) {
      if (cap.type === 'browser-extension' && cap.status !== 'planned') {
        driftChecks.push({
          id: cap.id,
          issue: 'BROWSER_EXTENSION_NOT_PLANNED',
          message: `浏览器扩展 ${cap.id} 状态应为 planned，当前为 ${cap.status}`,
        });
      }
    }

    // 检查 implement/execute 是否可调用
    const implementCallable = catalog.capabilities.some(
      c => c.id === 'artifact.e2e-test.browser.implement' && c.status === 'available'
    );
    const executeCallable = catalog.capabilities.some(
      c => c.id === 'artifact.e2e-test.browser.execute' && c.status === 'available'
    );
    if (implementCallable) {
      driftChecks.push({ issue: 'IMPLEMENT_SHOULD_NOT_BE_CALLABLE', message: 'implement 不应标记为 available' });
    }
    if (executeCallable) {
      driftChecks.push({ issue: 'EXECUTE_SHOULD_NOT_BE_CALLABLE', message: 'execute 不应标记为 available' });
    }
  }

  return {
    mode: 'doctor',
    status: driftChecks.length > 0 ? 'DRIFT_DETECTED' : checkResult.status,
    check: checkResult,
    driftChecks,
    catalogDigest: digest,
    catalogErrors: errors,
    writable: false,
  };
}
