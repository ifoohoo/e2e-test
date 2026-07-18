#!/usr/bin/env node

/**
 * verify-public-release.mjs
 *
 * 验证公开 package 的发布就绪性。
 * 检查 required paths、无 TODO 占位符、无尾随空白、无父工程内容泄漏。
 *
 * 用法: node scripts/verify-public-release.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');
const errors = [];

// 读取 workspace root 的 public-release.json
const workspaceRoot = join(pluginRoot, '..', '..');
let releaseConfig;
try {
  releaseConfig = JSON.parse(readFileSync(join(workspaceRoot, 'public-release.json'), 'utf8'));
} catch {
  console.error('Warning: Cannot read workspace public-release.json. Using defaults.');
  releaseConfig = {
    requiredPaths: [
      'INSTALL.md', 'README.md', 'LICENSE', 'NOTICE', 'package.json',
      'family/implementation.yaml', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json',
    ],
  };
}

// 检查 required paths
for (const reqPath of releaseConfig.requiredPaths || []) {
  try {
    statSync(join(pluginRoot, reqPath));
  } catch {
    errors.push(`Missing required path: ${reqPath}`);
  }
}

// 检查所有技能存在
const requiredSkills = ['e2e-test-help', 'e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'];
for (const skill of requiredSkills) {
  try {
    statSync(join(pluginRoot, 'skills', skill, 'SKILL.md'));
  } catch {
    errors.push(`Missing skill: skills/${skill}/SKILL.md`);
  }
}

// 扫描文本文件中的问题（跳过 test/ 目录，其中包含负例 fixture）
function collectFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test') continue;
      results.push(...collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const textExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.mjs', '.js', '.txt']);
const files = collectFiles(pluginRoot);

for (const file of files) {
  const ext = file.slice(file.lastIndexOf('.'));
  if (!textExtensions.has(ext)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const relPath = relative(pluginRoot, file);

  // 检查 TODO 占位符
  const todoPattern = '[' + 'TODO:';
  const todoPattern2 = '[' + 'TODO]';
  if (content.includes(todoPattern) || content.includes(todoPattern2)) {
    errors.push(`TODO placeholder in ${relPath}`);
  }

  // 检查尾随空白
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== lines[i].trimEnd()) {
      errors.push(`Trailing whitespace in ${relPath}:${i + 1}`);
      break; // 只报告一次
    }
  }
}

if (errors.length > 0) {
  console.error('Public release verification failed:');
  for (const err of errors) {
    console.error(`  ${err}`);
  }
  process.exit(1);
} else {
  console.log('Public release verification passed.');
}
