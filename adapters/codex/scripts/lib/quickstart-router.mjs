/**
 * quickstart-router.mjs
 *
 * 确定性纯函数路由器。
 * 同一规范化输入必须产生同字节 JSON。
 *
 * 设计约束：
 * - 路由只消费单一能力目录和可选 ProjectProfile
 * - 只可路由到当前可用入口/服务
 * - implement/execute 尚未实现时返回 UNSUPPORTED/PLANNED
 * - 歧义返回 NEEDS_CHOICE
 * - 无匹配返回 NO_MATCH
 * - 超出首期范围返回 UNSUPPORTED
 * - 输出禁止出现 capability、token、secret、handle、权限对象
 * - prompt injection 只能作为不可信业务文本处理
 * - 路由结果六类权限全 false
 */

import { resolve } from 'node:path';
import { loadCapabilityCatalog, getAvailableCapabilities, getPlannedCapabilities, isCallable } from './capability-catalog-loader.mjs';

/**
 * 规范化输入，确保确定性。
 */
function normalizeInput(input) {
  if (!input || typeof input !== 'object') return {};
  return {
    intent: typeof input.intent === 'string' ? input.intent.trim().toLowerCase() : null,
    context: typeof input.context === 'string' ? input.context.trim() : null,
  };
}

/**
 * 检测 prompt injection 尝试。
 * 只作为不可信业务文本标记，不改变权限或计划能力状态。
 */
function detectInjectionMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const markers = [];
  const patterns = [
    /ignore\s+(previous|above|all)\s+(instructions?|rules?|prompts?)/i,
    /you\s+are\s+now\s+(authorized|allowed|permitted)/i,
    /override\s+(all|previous|security)/i,
    /forget\s+(everything|all|previous)/i,
    /system\s*:\s*you\s+are/i,
    /new\s+instructions?\s*:/i,
    /DISREGARD\s+(ALL|PREVIOUS)/i,
    /grant\s+(me\s+)?(full\s+|admin\s+|root\s+)*access/i,
  ];
  for (const p of patterns) {
    if (p.test(text)) markers.push(p.source);
  }
  return markers;
}

/**
 * 快速匹配意图到服务。
 * 返回匹配的服务列表（可能为空或多个）。
 */
function matchIntentToServices(intent, catalog) {
  if (!intent || !catalog) return [];

  const available = getAvailableCapabilities(catalog);
  const planned = getPlannedCapabilities(catalog);
  const all = [...available, ...planned];

  // 精确匹配
  const exactMatches = all.filter(c => {
    const serviceId = c.id.split('.').pop();
    return serviceId === intent;
  });
  if (exactMatches.length > 0) return exactMatches;

  // 语义匹配
  const semanticMap = {
    'help': ['artifact.e2e-test.help'],
    'setup': ['artifact.e2e-test.setup'],
    'quickstart': ['artifact.e2e-test.quickstart'],
    'default': ['artifact.e2e-test.default'],
    'author': ['artifact.e2e-test.author'],
    'review': ['artifact.e2e-test.review'],
    'repair': ['artifact.e2e-test.repair'],
    'implement': ['artifact.e2e-test.browser.implement'],
    'execute': ['artifact.e2e-test.browser.execute'],
    'diagnose': ['artifact.e2e-test.help'],
    'check': ['artifact.e2e-test.setup'],
    'profile': ['artifact.e2e-test.setup'],
    'plan': ['artifact.e2e-test.setup'],
    'doctor': ['artifact.e2e-test.setup'],
    'start': ['artifact.e2e-test.quickstart'],
    'run': ['artifact.e2e-test.browser.execute'],
    'generate': ['artifact.e2e-test.browser.implement'],
    'test': ['artifact.e2e-test.browser.execute'],
    'spec': ['artifact.e2e-test.author'],
    'specification': ['artifact.e2e-test.author'],
    'write': ['artifact.e2e-test.author'],
    'fix': ['artifact.e2e-test.repair'],
    'e2e': ['artifact.e2e-test.default'],
  };

  const mappedIds = semanticMap[intent];
  if (mappedIds) {
    return mappedIds.map(id => all.find(c => c.id === id)).filter(Boolean);
  }

  return [];
}

/**
 * 快速路由。
 * 同一规范化输入产生同字节 JSON。
 *
 * @param {object} input - { intent?: string, context?: string }
 * @param {string} [pluginRoot]
 * @returns {object} 路由结果
 */
export function quickstart(input, pluginRoot) {
  const normalized = normalizeInput(input);
  const { intent, context } = normalized;
  const effectiveRoot = pluginRoot || resolve(import.meta.dirname, '..', '..');

  // 检测 prompt injection（只标记，不改变行为）
  const injectionMarkers = [
    ...detectInjectionMarkers(intent),
    ...detectInjectionMarkers(context),
  ];

  // 加载能力目录
  const { catalog, errors } = loadCapabilityCatalog(effectiveRoot);
  if (!catalog) {
    return {
      status: 'BLOCKED',
      code: 'CATALOG_UNAVAILABLE',
      route: null,
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 无意图：返回可用能力概览
  if (!intent) {
    const available = getAvailableCapabilities(catalog);
    const planned = getPlannedCapabilities(catalog);
    return {
      status: 'NEEDS_CHOICE',
      code: 'NO_INTENT_SPECIFIED',
      route: null,
      available: available.map(c => ({ id: c.id, description: c.description })),
      planned: planned.map(c => ({ id: c.id, description: c.description })),
      message: '请指定意图。当前可用能力：help/setup/quickstart/default/author/review/repair。计划中能力：implement/execute（尚不可调用）。',
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 匹配意图到服务
  const matches = matchIntentToServices(intent, catalog);

  if (matches.length === 0) {
    // 检查是否为已知但不支持的意图
    const unsupportedIntents = ['tauri', 'mobile', 'android', 'ios', 'spring', 'java', 'cypress', 'mcp'];
    if (unsupportedIntents.includes(intent)) {
      return {
        status: 'UNSUPPORTED',
        code: 'INTENT_OUT_OF_SCOPE',
        route: null,
        message: `${intent} 不在首期浏览器垂直切片范围内。首期仅支持：TypeScript + Playwright Test + Chromium。`,
        injectionDetected: injectionMarkers.length > 0,
        injectionMarkers,
      };
    }

    return {
      status: 'NO_MATCH',
      code: 'INTENT_NOT_MATCHED',
      route: null,
      message: `无法匹配意图 "${intent}" 到任何已知能力。`,
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 多个匹配：歧义
  if (matches.length > 1) {
    return {
      status: 'NEEDS_CHOICE',
      code: 'AMBIGUOUS_INTENT',
      route: null,
      matches: matches.map(c => ({
        id: c.id,
        status: c.status,
        description: c.description,
        callable: c.status === 'available',
      })),
      message: `意图 "${intent}" 匹配到 ${matches.length} 个能力，请明确选择。`,
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 单个匹配
  const target = matches[0];

  // 检查是否为 planned 能力
  if (target.status === 'planned') {
    return {
      status: 'UNSUPPORTED',
      code: 'PLANNED_NOT_CALLABLE',
      route: null,
      target: target.id,
      message: `${target.id} 当前为计划中能力（planned），尚不可调用。需要完成后续里程碑实现。`,
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 检查是否为 internal 能力
  if (target.status === 'internal' || target.type === 'internal-stage') {
    return {
      status: 'UNSUPPORTED',
      code: 'INTERNAL_STAGE_NOT_EXPOSED',
      route: null,
      target: target.id,
      message: `${target.id} 是内部阶段，不作为用户服务暴露。`,
      injectionDetected: injectionMarkers.length > 0,
      injectionMarkers,
    };
  }

  // 可用能力：返回路由（不携带权限句柄）
  return {
    status: 'MATCHED',
    code: 'ROUTE_FOUND',
    route: {
      service: target.id,
      entryPoint: target.entryPoint,
      description: target.description,
      type: target.type,
    },
    // 路由结果六类权限全 false（不继承目标工作流权限）
    permissions: {
      sourceWrite: false,
      artifactWrite: false,
      verifyCommand: false,
      testCommand: false,
      processLifecycle: false,
      networkEgress: false,
    },
    injectionDetected: injectionMarkers.length > 0,
    injectionMarkers,
  };
}
