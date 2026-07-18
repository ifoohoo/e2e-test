#!/usr/bin/env node

/**
 * build-adapters.mjs
 *
 * 确定性生成 Codex/Claude adapter。skills/ 是唯一 authoring source。
 * scripts/gate-status.mjs 是唯一脚本 authoring source。
 *
 * 用法:
 *   node scripts/build-adapters.mjs          # 构建
 *   node scripts/build-adapters.mjs --check  # 检查漂移（CI 模式）
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');
const skillsDir = join(pluginRoot, 'skills');
const scriptsDir = join(pluginRoot, 'scripts');
const adaptersDir = join(pluginRoot, 'adapters');
const isCheck = process.argv.includes('--check');

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
      name: 'mzdbxqh',
      url: 'https://github.com/mzdbxqh',
    },
    license: pkg.license,
    keywords: pkg.keywords || [],
    skills: './skills/',
  }, null, 2) + '\n';
}

const skills = collectSkillDirs(skillsDir);
const adapterTypes = ['codex', 'claude'];

let driftDetected = false;

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

// 复制 gate-status.mjs 和 package.json 到两个 adapter
const gateStatusSource = join(scriptsDir, 'gate-status.mjs');
const gateStatusContent = readFileSync(gateStatusSource, 'utf8');
const packageJsonContent = readFileSync(join(pluginRoot, 'package.json'), 'utf8');

for (const adapterType of adapterTypes) {
  const adapterRoot = join(adaptersDir, adapterType);

  // 复制 scripts/gate-status.mjs
  const scriptsTargetDir = join(adapterRoot, 'scripts');
  const gateStatusTargetFile = join(scriptsTargetDir, 'gate-status.mjs');

  if (isCheck) {
    try {
      const existing = readFileSync(gateStatusTargetFile, 'utf8');
      if (existing !== gateStatusContent) {
        console.error(`DRIFT: ${adapterType}/scripts/gate-status.mjs`);
        driftDetected = true;
      }
    } catch {
      console.error(`MISSING: ${adapterType}/scripts/gate-status.mjs`);
      driftDetected = true;
    }
  } else {
    mkdirSync(scriptsTargetDir, { recursive: true });
    writeFileSync(gateStatusTargetFile, gateStatusContent);
  }

  // 复制 package.json（adapter 需要它来获取版本信息）
  const packageJsonTargetFile = join(adapterRoot, 'package.json');

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

if (isCheck) {
  if (driftDetected) {
    console.error('Adapter drift detected. Run: node scripts/build-adapters.mjs');
    process.exit(1);
  } else {
    console.log('Adapter check passed. No drift detected.');
  }
} else {
  // skills + gate-status.mjs + package.json per adapter + claude plugin.json
  const fileCount = skills.length * adapterTypes.length + adapterTypes.length * 2 + 1;
  console.log(`Built ${fileCount} adapter files.`);
}
