#!/usr/bin/env node

/**
 * build-adapters.mjs
 *
 * 确定性生成 Codex/Claude adapter。skills/ 是唯一 authoring source。
 * scripts/ 下的确定性脚本是唯一脚本 authoring source。
 *
 * 用法:
 *   node scripts/build-adapters.mjs          # 构建
 *   node scripts/build-adapters.mjs --check  # 检查漂移（CI 模式）
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const pluginRoot = join(import.meta.dirname, '..');
const skillsDir = join(pluginRoot, 'skills');
const scriptsDir = join(pluginRoot, 'scripts');
const adaptersDir = join(pluginRoot, 'adapters');
const isCheck = process.argv.includes('--check');
const skipProofCheck = process.argv.includes('--skip-proof-check');

// 读取 package.json 获取版本等信息
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

function collectSkillDirs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, 'SKILL.md');
      try {
        statSync(skillMd);
        results.push({ name: entry.name, dir: join(dir, entry.name) });
      } catch {
        // no SKILL.md, skip
      }
    }
  }
  return results;
}

function readSkillContent(skillDir) {
  const skillMd = join(skillDir, 'SKILL.md');
  return readFileSync(skillMd, 'utf8');
}

function generateClaudePluginJson() {
  return JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: {
      name: 'ifoohoo',
      url: 'https://github.com/ifoohoo',
    },
    license: pkg.license,
    keywords: pkg.keywords || [],
    skills: './skills/',
  }, null, 2) + '\n';
}

const skills = collectSkillDirs(skillsDir);
const adapterTypes = ['codex', 'claude'];

// 需要复制的脚本文件（adapter 自包含所需）
const scriptsToSync = [
  'gate-status.mjs',
  'conformance-runner.mjs',
  'bundle-digest.mjs',
  'stage-runner.mjs',
  'service-runner.mjs',
  'service-dispatch.mjs',
  'behavior-qualification-scenario.mjs',
  'behavior-qualification-prepare.mjs',
  'behavior-qualification-verify.mjs',
  'behavior-qualification-trials.mjs',
  'forward-trials-prepare.mjs',
  'method-forward-qualification-prepare.mjs',
  'method-forward-author-driver.mjs',
  'method-forward-trial-runner.mjs',
  'method-forward-reviewer.mjs',
  'method-forward-qualification-aggregate.mjs',
  'method-forward-batch-runner.mjs',
  'verify-truthfulness.mjs',
  'browser-extension-runner.mjs',
];

let driftDetected = false;

function collectDirFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDirFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// 生成技能副本
for (const adapterType of adapterTypes) {
  for (const skill of skills) {
    const targetDir = join(adaptersDir, adapterType, 'skills', skill.name);
    const targetFile = join(targetDir, 'SKILL.md');

    const content = readSkillContent(skill.dir);

    if (isCheck) {
      try {
        const existing = readFileSync(targetFile, 'utf8');
        if (existing !== content) {
          console.error(`DRIFT: ${adapterType}/skills/${skill.name}/SKILL.md`);
          driftDetected = true;
        }
      } catch {
        console.error(`MISSING: ${adapterType}/skills/${skill.name}/SKILL.md`);
        driftDetected = true;
      }
    } else {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetFile, content);
    }
  }
}

// 同步技能本地资源闭包（references/、assets/、schemas/）到两个 adapter
const skillResourceDirs = ['references', 'assets', 'schemas'];

for (const adapterType of adapterTypes) {
  const adapterRoot = join(adaptersDir, adapterType);
  for (const skill of skills) {
    for (const resDir of skillResourceDirs) {
      const sourceDir = join(skill.dir, resDir);
      const targetDir = join(adapterRoot, 'skills', skill.name, resDir);
      let sourceFiles;
      try {
        sourceFiles = collectDirFiles(sourceDir);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (isCheck) {
          let staleFiles = [];
          try {
            staleFiles = collectDirFiles(targetDir);
          } catch (targetError) {
            if (targetError?.code !== 'ENOENT') throw targetError;
          }
          for (const targetFile of staleFiles) {
            const relPath = relative(adapterRoot, targetFile);
            console.error(`STALE: ${adapterType}/${relPath} exists in adapter but not in canonical skill`);
            driftDetected = true;
          }
        } else {
          rmSync(targetDir, { recursive: true, force: true });
        }
        continue;
      }

      const sourceRelPaths = new Set();
      if (!isCheck) {
        rmSync(targetDir, { recursive: true, force: true });
      }

      for (const sourceFile of sourceFiles) {
        const relPath = relative(pluginRoot, sourceFile);
        sourceRelPaths.add(relPath);
        const targetFile = join(adaptersDir, adapterType, relPath);

        const content = readFileSync(sourceFile);

        if (isCheck) {
          try {
            const existing = readFileSync(targetFile);
            if (!content.equals(existing)) {
              console.error(`DRIFT: ${adapterType}/${relPath}`);
              driftDetected = true;
            }
          } catch {
            console.error(`MISSING: ${adapterType}/${relPath}`);
            driftDetected = true;
          }
        } else {
          mkdirSync(join(targetFile, '..'), { recursive: true });
          writeFileSync(targetFile, content);
        }
      }

      // Check for stale files in adapter skill resource dir
      if (isCheck) {
        let targetFiles = [];
        try {
          targetFiles = collectDirFiles(targetDir);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        for (const targetFile of targetFiles) {
          const relPath = relative(adapterRoot, targetFile);
          if (!sourceRelPaths.has(relPath)) {
            console.error(`STALE: ${adapterType}/${relPath} exists in adapter but not in canonical skill`);
            driftDetected = true;
          }
        }
      }
    }
  }
}

// 同步脚本文件到两个 adapter
for (const adapterType of adapterTypes) {
  const adapterRoot = join(adaptersDir, adapterType);
  const scriptsTargetDir = join(adapterRoot, 'scripts');

  for (const scriptName of scriptsToSync) {
    const sourceFile = join(scriptsDir, scriptName);
    const targetFile = join(scriptsTargetDir, scriptName);

    let content;
    try {
      content = readFileSync(sourceFile, 'utf8');
    } catch {
      // script doesn't exist yet, skip
      continue;
    }

    if (isCheck) {
      try {
        const existing = readFileSync(targetFile, 'utf8');
        if (existing !== content) {
          console.error(`DRIFT: ${adapterType}/scripts/${scriptName}`);
          driftDetected = true;
        }
      } catch {
        console.error(`MISSING: ${adapterType}/scripts/${scriptName}`);
        driftDetected = true;
      }
    } else {
      mkdirSync(scriptsTargetDir, { recursive: true });
      writeFileSync(targetFile, content);
    }
  }

  // 复制 package.json（adapter 需要它来获取版本信息）
  const packageJsonTargetFile = join(adapterRoot, 'package.json');
  const packageJsonContent = readFileSync(join(pluginRoot, 'package.json'), 'utf8');

  if (isCheck) {
    try {
      const existing = readFileSync(packageJsonTargetFile, 'utf8');
      if (existing !== packageJsonContent) {
        console.error(`DRIFT: ${adapterType}/package.json`);
        driftDetected = true;
      }
    } catch {
      console.error(`MISSING: ${adapterType}/package.json`);
      driftDetected = true;
    }
  } else {
    writeFileSync(packageJsonTargetFile, packageJsonContent);
  }
}

// 同步自包含目录到两个 adapter。scripts/lib 是场景验证器的共享确定性内核。
const dirsToSync = [
  'authority-api', 'assets', 'schemas', 'references', 'fixtures', 'conformance',
  'family', 'stages', 'workers', 'scripts/lib', 'scripts/stage-validators',
];

for (const adapterType of adapterTypes) {
  const adapterRoot = join(adaptersDir, adapterType);

  for (const dirName of dirsToSync) {
    const sourceDir = join(pluginRoot, dirName);
    let sourceFiles;
    try {
      sourceFiles = collectDirFiles(sourceDir);
    } catch {
      // dir doesn't exist, skip
      continue;
    }

    const sourceRelPaths = new Set();

    for (const sourceFile of sourceFiles) {
      const relPath = relative(pluginRoot, sourceFile);
      sourceRelPaths.add(relPath);
      const targetFile = join(adapterRoot, relPath);

      // 这些文件是每个 canonical root 的独立证明，不从 root 覆盖 adapter。
      if (relPath === 'family/implementation.yaml' ||
          relPath === 'conformance/last-run.json' ||
          relPath === 'conformance/behavior-qualification.json' ||
          relPath === 'conformance/method-forward-qualification.json') continue;

      const content = readFileSync(sourceFile);

      if (isCheck) {
        try {
          const existing = readFileSync(targetFile);
          if (!content.equals(existing)) {
            console.error(`DRIFT: ${adapterType}/${relPath}`);
            driftDetected = true;
          }
        } catch {
          console.error(`MISSING: ${adapterType}/${relPath}`);
          driftDetected = true;
        }
      } else {
        mkdirSync(join(targetFile, '..'), { recursive: true });
        writeFileSync(targetFile, content);
      }
    }

    // Check for extra stale files in target dir that don't exist in source
    if (isCheck) {
      const targetDir = join(adapterRoot, dirName);
      try {
        const targetFiles = collectDirFiles(targetDir);
        for (const targetFile of targetFiles) {
          const relPath = relative(adapterRoot, targetFile);
          if (!sourceRelPaths.has(relPath)) {
            console.error(`STALE: ${adapterType}/${relPath} exists in adapter but not in source`);
            driftDetected = true;
          }
        }
      } catch {
        // target dir doesn't exist, that's fine for check mode
      }
    }
  }
}

// 生成 Claude adapter plugin.json
const claudePluginJson = generateClaudePluginJson();
const claudePluginDir = join(adaptersDir, 'claude', '.claude-plugin');
const claudePluginFile = join(claudePluginDir, 'plugin.json');

if (isCheck) {
  try {
    const existing = readFileSync(claudePluginFile, 'utf8');
    if (existing !== claudePluginJson) {
      console.error('DRIFT: adapters/claude/.claude-plugin/plugin.json');
      driftDetected = true;
    }
  } catch {
    console.error('MISSING: adapters/claude/.claude-plugin/plugin.json');
    driftDetected = true;
  }
} else {
  mkdirSync(claudePluginDir, { recursive: true });
  writeFileSync(claudePluginFile, claudePluginJson);
}

// Post-build: compute correct treeDigest per adapter (each adapter is a separate canonical root)
// The adapter's scripts/ dir has fewer files than root, so the bundle digest differs.
const adapterTreeDigests = {};

{
  // implementation descriptor 的 API、服务、bundle roots 与生命周期来自根 authoring source；
  // treeDigest / deterministicAttestation 是每个 canonical root 的独立证明，必须保留。
  const rootImpl = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
  for (const adapterType of adapterTypes) {
    const implPath = join(adaptersDir, adapterType, 'family', 'implementation.yaml');
    const current = readFileSync(implPath, 'utf8');
    const treeDigest = current.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
    const attestation = current.match(/^\s*deterministicAttestation:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
    let expected = rootImpl;
    if (treeDigest) expected = expected.replace(/(^\s*treeDigest:\s*)sha256:[a-f0-9]{64}\s*$/m, `$1${treeDigest}`);
    if (attestation) expected = expected.replace(/(^\s*deterministicAttestation:\s*)sha256:[a-f0-9]{64}\s*$/m, `$1${attestation}`);
    if (isCheck) {
      if (current !== expected) {
        console.error(`DRIFT: ${adapterType}/family/implementation.yaml non-proof fields`);
        driftDetected = true;
      }
    } else {
      writeFileSync(implPath, expected, 'utf8');
    }
  }

  const bundleDigestScript = join(pluginRoot, 'scripts', 'bundle-digest.mjs');
  for (const adapterType of adapterTypes) {
    const adapterRoot = join(adaptersDir, adapterType);

    // Compute the expected adapter treeDigest using bundle-digest.mjs
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [bundleDigestScript, '--observe', '--json'], {
        cwd: adapterRoot,
        encoding: 'utf8',
        env: { ...process.env, E2E_TEST_PLUGIN_ROOT: adapterRoot },
        timeout: 30000,
      });
    } catch (err) {
      stdout = err.stdout;
    }
    if (stdout) {
      try {
        const result = JSON.parse(stdout);
        if (result.digest) {
          adapterTreeDigests[adapterType] = result.digest;
        }
      } catch {
        // parse failed
      }
    }

    const implPath = join(adapterRoot, 'family', 'implementation.yaml');
    const expectedDigest = adapterTreeDigests[adapterType];

    if (expectedDigest) {
      if (isCheck) {
        // Verify the adapter's treeDigest matches what the Registry computes
        const implContent = readFileSync(implPath, 'utf8');
        const currentDigest = implContent.match(/^\s*treeDigest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
        if (currentDigest !== expectedDigest) {
          console.error(`DRIFT: ${adapterType}/family/implementation.yaml treeDigest: declared ${currentDigest}, expected ${expectedDigest}`);
          driftDetected = true;
        }
        if (!skipProofCheck) {
          // Verify adapter conformance evidence (R32 三根闭包)：
          // last-run.json 必须与当前 descriptor 的 bundle/attestation 一致。
          const adapterConformanceDir = join(adapterRoot, 'conformance');
          const declaredAttestation = implContent.match(
            /^\s*deterministicAttestation:\s*(sha256:[a-f0-9]{64})\s*$/m,
          )?.[1];
          const lastRunPath = join(adapterConformanceDir, 'last-run.json');
          try {
            const lastRun = JSON.parse(readFileSync(lastRunPath, 'utf8'));
            if (lastRun.status !== 'PASS' ||
                lastRun.bundleDigest !== expectedDigest ||
                lastRun.attestation?.digest !== declaredAttestation) {
              console.error(
                `DRIFT: ${adapterType}/conformance/last-run.json bundleDigest/attestation proof identity`,
              );
              driftDetected = true;
            }
          } catch (err) {
            console.error(`DRIFT: ${adapterType}/conformance/last-run.json unreadable: ${err.message}`);
            driftDetected = true;
          }
          // behavior qualification 顶层 bundle 属于 root；adapter 的本地证明
          // 位于 scenarioIdentities.<host>，必须与 adapter descriptor 一致。
          const bqPath = join(adapterConformanceDir, 'behavior-qualification.json');
          try {
            const bq = JSON.parse(readFileSync(bqPath, 'utf8'));
            const localIdentity = bq.evidence?.scenarioIdentities?.[adapterType];
            if (bq.qualificationStatus !== 'QUALIFIED' ||
                localIdentity?.bundleDigest !== expectedDigest ||
                localIdentity?.deterministicAttestation !== declaredAttestation) {
              console.error(
                `DRIFT: ${adapterType}/conformance/behavior-qualification.json local proof identity`,
              );
              driftDetected = true;
            }
          } catch (err) {
            console.error(`DRIFT: ${adapterType}/conformance/behavior-qualification.json unreadable: ${err.message}`);
            driftDetected = true;
          }
        }
      } else {
        // Build mode: write the correct treeDigest
        let implContent = readFileSync(implPath, 'utf8');
        implContent = implContent.replace(
          /(\s*treeDigest:\s*)sha256:[a-f0-9]{64}/,
          `$1${expectedDigest}`,
        );
        writeFileSync(implPath, implContent, 'utf8');
      }
    }
  }
}

if (isCheck) {
  if (driftDetected) {
    console.error('Adapter drift detected. Run: node scripts/build-adapters.mjs');
    process.exit(1);
  } else {
    console.log('Adapter check passed. No drift detected.');
  }
} else {
  const fileCount = skills.length * adapterTypes.length + scriptsToSync.length * adapterTypes.length + adapterTypes.length + 1;
  console.log(`Built ${fileCount} adapter files.`);
}
