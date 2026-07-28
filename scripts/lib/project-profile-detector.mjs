/**
 * project-profile-detector.mjs
 *
 * 内部 ProjectProfile detector。
 * 只读项目文件扫描器，严格落地 accepted M2 exact-shape。
 *
 * 允许读取：
 * - repo topology
 * - package.json、已支持的 workspace manifest
 * - lockfile 与 package manager 证据
 * - TypeScript/JavaScript 配置
 * - Playwright package/config 的文件存在性和内容摘要
 * - 候选测试目录
 * - 用户显式提供的结构化 start command、baseURL、readinessURL
 * - 可由文件直接证明的不支持边界
 *
 * 禁止行为：
 * - 不执行或 import 项目配置
 * - 不运行 start/build/test、package script、Playwright 或任意项目二进制
 * - 不启动子进程、服务或浏览器
 * - 不联网
 * - 不遍历项目根之外的路径，不跟随符号链接逃逸
 * - 不读取 .env 的值，不把 secret 内容写入 evidence
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { stableDigest, canonicalize } from './digest.mjs';

// ─── Path safety ───

/**
 * 检查路径是否在项目根目录内（不跟随符号链接逃逸）。
 */
function isWithinRoot(filePath, root) {
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  return !rel.startsWith('..') && rel !== '' && !rel.startsWith('/');
}

/**
 * 安全读取文件，限制在项目根内。
 */
function safeReadFile(filePath, root) {
  if (!isWithinRoot(filePath, root)) return null;
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      // 不跟随符号链接——读取链接目标路径但不 resolve
      return null;
    }
    if (!st.isFile()) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 安全列出目录内容。
 */
function safeListDir(dirPath, root) {
  if (!isWithinRoot(dirPath, root)) return [];
  try {
    const st = lstatSync(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

// ─── Detection helpers ───

/**
 * 检测 package manager。
 */
function detectPackageManager(root) {
  const evidence = [];
  const pnpmDigest = fileDigest(join(root, 'pnpm-lock.yaml'), root);
  if (pnpmDigest) {
    evidence.push({ claim: 'pnpm', source: 'pnpm-lock.yaml', digest: pnpmDigest });
    return { packageManager: 'pnpm', evidence };
  }
  const yarnDigest = fileDigest(join(root, 'yarn.lock'), root);
  if (yarnDigest) {
    evidence.push({ claim: 'yarn', source: 'yarn.lock', digest: yarnDigest });
    return { packageManager: 'yarn', evidence };
  }
  const npmDigest = fileDigest(join(root, 'package-lock.json'), root);
  if (npmDigest) {
    evidence.push({ claim: 'npm', source: 'package-lock.json', digest: npmDigest });
    return { packageManager: 'npm', evidence };
  }
  return { packageManager: 'unknown', evidence: [] };
}

/**
 * 检测仓库拓扑。
 */
function detectRepoTopology(root) {
  const evidence = [];
  const pkgJson = safeReadFile(join(root, 'package.json'), root);
  let kind = 'single';
  let language = 'other'; // 冻结枚举：typescript | javascript | other

  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const pkgDigest = stableDigest(pkg);
      evidence.push({ claim: 'package.json exists', source: 'package.json', digest: pkgDigest });

      // 检测 monorepo
      if (pkg.workspaces || existsSync(join(root, 'pnpm-workspace.yaml'))) {
        const monorepoSource = pkg.workspaces ? 'package.json' : 'pnpm-workspace.yaml';
        const monorepoDigest = pkg.workspaces ? pkgDigest : fileDigest(join(root, 'pnpm-workspace.yaml'), root);
        if (monorepoDigest) {
          kind = 'monorepo';
          evidence.push({ claim: 'monorepo', source: monorepoSource, digest: monorepoDigest });
        }
      }

      // 检测语言（小写枚举：typescript | javascript | other）
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        language = 'typescript';
        evidence.push({ claim: 'typescript dependency', source: 'package.json', digest: pkgDigest });
      } else if (fileDigest(join(root, 'tsconfig.json'), root)) {
        const tsDigest = fileDigest(join(root, 'tsconfig.json'), root);
        language = 'typescript';
        evidence.push({ claim: 'typescript config', source: 'tsconfig.json', digest: tsDigest });
      } else if (fileDigest(join(root, 'jsconfig.json'), root)) {
        const jsDigest = fileDigest(join(root, 'jsconfig.json'), root);
        language = 'javascript';
        evidence.push({ claim: 'javascript config', source: 'jsconfig.json', digest: jsDigest });
      }
    } catch {
      // package.json 解析失败
    }
  }

  return { kind, packageManager: detectPackageManager(root), language, evidence };
}

/**
 * 检测 Playwright 安装和配置。
 */
function detectPlaywright(root) {
  const evidence = [];
  let present = false;
  let version = undefined;
  let configPath = undefined;
  let configDigest = undefined;

  // 检查 package.json 中的 Playwright 依赖
  const pkgJson = safeReadFile(join(root, 'package.json'), root);
  let pkgDigest = null;
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      pkgDigest = stableDigest(pkg);
      const dep = pkg.devDependencies?.['@playwright/test'] || pkg.dependencies?.['@playwright/test'];
      if (dep) {
        present = true;
        version = dep.replace(/[\^~>=<]/g, '');
        evidence.push({ claim: `@playwright/test@${version}`, source: 'package.json', digest: pkgDigest });
      }
    } catch { /* ignore */ }
  }

  // 检查 Playwright 配置文件
  const configFiles = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.mts',
  ];
  for (const cf of configFiles) {
    const fullPath = join(root, cf);
    if (existsSync(fullPath)) {
      const content = safeReadFile(fullPath, root);
      if (content) {
        configPath = cf;
        configDigest = stableDigest(content);
        present = true;
        evidence.push({ claim: `Playwright config: ${cf}`, source: cf, digest: configDigest });
        break;
      }
    }
  }

  return { present, version, configPath, configDigest, evidence };
}

/**
 * 检测候选测试目录。
 */
function detectCandidateTestDirs(root) {
  const candidates = [];
  const evidence = [];
  const dirs = ['tests', 'test', 'e2e', 'e2e-tests', '__tests__', 'spec'];

  for (const dir of dirs) {
    const fullPath = join(root, dir);
    if (existsSync(fullPath)) {
      try {
        const st = lstatSync(fullPath);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          candidates.push(dir);
          const dDigest = dirDigest(fullPath, root);
          evidence.push({ claim: `candidate test dir: ${dir}`, source: dir, digest: dDigest });
        }
      } catch { /* ignore */ }
    }
  }

  return { candidates, evidence };
}

/**
 * 检测不支持的边界。
 */
function detectUnsupported(root) {
  const evidence = [];
  const unsupported = {
    tauri: false,
    rust: false,
    mobile: false,
    javaSpring: false,
    production: false,
  };

  // Tauri
  if (isSafeDirectory(join(root, 'src-tauri'), root)) {
    unsupported.tauri = true;
    const tauriDigest = dirDigest(join(root, 'src-tauri'), root);
    evidence.push({ claim: 'Tauri detected', source: 'src-tauri/', digest: tauriDigest });
  }
  const cargoDigest = fileDigest(join(root, 'Cargo.toml'), root);
  if (cargoDigest) {
    unsupported.rust = true;
    evidence.push({ claim: 'Rust detected', source: 'Cargo.toml', digest: cargoDigest });
  }

  // 移动端
  if (isSafeDirectory(join(root, 'android'), root)) {
    unsupported.mobile = true;
    const androidDigest = dirDigest(join(root, 'android'), root);
    evidence.push({ claim: 'Mobile detected', source: 'android/', digest: androidDigest });
  } else if (isSafeDirectory(join(root, 'ios'), root)) {
    unsupported.mobile = true;
    const iosDigest = dirDigest(join(root, 'ios'), root);
    evidence.push({ claim: 'Mobile detected', source: 'ios/', digest: iosDigest });
  }

  // Java/Spring
  const pomDigest = fileDigest(join(root, 'pom.xml'), root);
  const gradleDigest = fileDigest(join(root, 'build.gradle'), root);
  if (pomDigest) {
    unsupported.javaSpring = true;
    evidence.push({ claim: 'Java/Spring detected', source: 'pom.xml', digest: pomDigest });
  } else if (gradleDigest) {
    unsupported.javaSpring = true;
    evidence.push({ claim: 'Java/Spring detected', source: 'build.gradle', digest: gradleDigest });
  }

  // 生产环境标识
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    unsupported.production = true;
    const envDigest = envFactDigest(['NODE_ENV', 'VERCEL_ENV']);
    evidence.push({ claim: 'Production environment detected', source: 'env vars', digest: envDigest });
  }

  return { unsupported, evidence };
}

/**
 * 计算文件摘要。
 */
function fileDigest(filePath, root) {
  const content = safeReadFile(filePath, root);
  return content === null ? null : stableDigest(content);
}

function isSafeDirectory(dirPath, root) {
  if (!isWithinRoot(dirPath, root)) return false;
  try {
    const st = lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 计算目录投影摘要（受限、排序后的目录项）。
 * 只包含名称，不读取内容。
 * 空目录返回空数组的摘要。
 */
function dirDigest(dirPath, root) {
  const entries = safeListDir(dirPath, root);
  const sorted = [...entries].sort();
  return stableDigest(sorted);
}

/**
 * 计算环境边界事实摘要（不含 secret 原文的规范化布尔事实投影）。
 */
function envFactDigest(envKeys) {
  const facts = {};
  for (const key of envKeys) {
    facts[key] = process.env[key] === 'production';
  }
  return stableDigest(facts);
}

/**
 * 确定性生成 profileId。
 */
function generateProfileId(root) {
  return `profile@${stableDigest(resolve(root))}`;
}

// ─── Main detector ───

/**
 * 检测 ProjectProfile。
 * 严格落地 accepted M2 exact-shape。
 *
 * @param {string} projectRoot - 项目根目录
 * @param {{ startCommand?: { runner: string, invocation: string, args: string[] }, baseURL?: string, readinessURL?: string }} [explicitFacts]
 * @param {string} [pluginRoot] - 插件根目录（用于加载 schema）
 * @returns {object} ProjectProfile
 */
export function detectProjectProfile(projectRoot, explicitFacts, pluginRoot) {
  if (!projectRoot || !existsSync(projectRoot)) {
    return {
      status: 'BLOCKED',
      code: 'PROJECT_ROOT_INVALID',
      profile: null,
    };
  }

  const root = resolve(projectRoot);
  const allEvidence = [];
  const conflicts = [];
  const unknowns = [];

  // 1. Repo topology
  const topology = detectRepoTopology(root);
  allEvidence.push(...topology.evidence);

  // 2. Playwright
  const playwright = detectPlaywright(root);
  allEvidence.push(...playwright.evidence);

  // 3. Candidate test dirs
  const testDirs = detectCandidateTestDirs(root);
  allEvidence.push(...testDirs.evidence);

  // 4. Unsupported boundaries
  const { unsupported, evidence: unsupportedEvidence } = detectUnsupported(root);
  allEvidence.push(...unsupportedEvidence);

  // 5. Explicit facts (only from user-provided structured input)
  // 可选未知字段省略，不得输出 null
  const explicit = {};
  if (explicitFacts?.baseURL) {
    explicit.baseURL = explicitFacts.baseURL;
  }
  if (explicitFacts?.readinessURL) {
    explicit.readinessURL = explicitFacts.readinessURL;
  }

  // startCommand only from explicit structured input, never auto-detected
  // 未显式提供时省略，不得输出 null
  const startCommand = explicitFacts?.startCommand || undefined;

  // 6. Confidence calculation
  let confidence = 0.5; // base
  if (topology.language !== 'other') confidence += 0.1; // 已识别语言
  if (playwright.present) confidence += 0.15;
  if (testDirs.candidates.length > 0) confidence += 0.1;
  if (startCommand) confidence += 0.1;
  if (explicit.baseURL) confidence += 0.05;
  confidence = Math.min(confidence, 1.0);

  // Detect conflicts
  if (topology.kind === 'monorepo' && testDirs.candidates.length > 1) {
    conflicts.push('monorepo with multiple candidate test dirs — ambiguous which to use');
  }
  if (playwright.present && !playwright.configPath) {
    conflicts.push('Playwright dependency found but no config file detected');
  }
  if (unsupported.tauri || unsupported.rust) {
    conflicts.push('Tauri/Rust runtime detected — not supported in first-phase browser slice');
    confidence = Math.min(confidence, 0.4);
  }
  if (unsupported.mobile) {
    conflicts.push('Mobile runtime detected — not supported');
    confidence = Math.min(confidence, 0.3);
  }
  if (unsupported.javaSpring) {
    conflicts.push('Java/Spring detected — not supported in first-phase');
    confidence = Math.min(confidence, 0.3);
  }

  // Unknowns
  if (topology.language === 'other') unknowns.push('primary language');
  if (!playwright.present) unknowns.push('Playwright installation');
  if (!startCommand) unknowns.push('start command (must be explicitly provided)');
  if (!explicit.baseURL) unknowns.push('baseURL (must be explicitly provided)');

  // Sort evidence deterministically
  allEvidence.sort((a, b) => {
    if (a.source < b.source) return -1;
    if (a.source > b.source) return 1;
    if (a.claim < b.claim) return -1;
    if (a.claim > b.claim) return 1;
    return 0;
  });

  // Build profile (exact M2 shape)
  // playwright: present=false 时只要求 present，其余不存在的事实省略
  const playwrightObj = { present: playwright.present };
  if (playwright.present) {
    // 只有当 present=true 且值存在时才输出
    if (playwright.version !== undefined) {
      playwrightObj.version = playwright.version;
    }
    if (playwright.configPath !== undefined) {
      playwrightObj.configPath = playwright.configPath;
    }
    if (playwright.configDigest !== undefined) {
      playwrightObj.configDigest = playwright.configDigest;
    }
  }

  const profile = {
    profileId: generateProfileId(root),
    projectRootDigest: stableDigest(resolve(root)),
    repoTopology: {
      kind: topology.kind,
      packageManager: topology.packageManager.packageManager,
      language: topology.language,
    },
    playwright: playwrightObj,
    candidateTestDirs: testDirs.candidates,
    explicitFacts: explicit,
    facts: {
      evidence: allEvidence,
      confidence,
      conflicts,
      unknowns,
    },
    unsupported: {
      tauri: unsupported.tauri,
      rust: unsupported.rust,
      mobile: unsupported.mobile,
      javaSpring: unsupported.javaSpring,
      production: unsupported.production,
    },
    profileDigest: null, // computed below
  };

  // startCommand 未显式提供时省略，不得输出 null
  if (startCommand) {
    profile.startCommand = startCommand;
  }

  // Compute profileDigest (stableDigest of profile without profileDigest)
  const profileForDigest = { ...profile };
  delete profileForDigest.profileDigest;
  profile.profileDigest = stableDigest(profileForDigest);

  return {
    status: 'OK',
    code: 'PROFILE_DETECTED',
    profile,
  };
}
