#!/usr/bin/env node

/**
 * check-skills.mjs
 *
 * 验证所有技能目录结构和 SKILL.md 存在且格式合法。
 *
 * 用法: node scripts/check-skills.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');
const skillsDir = join(pluginRoot, 'skills');
const stagesDir = join(pluginRoot, 'stages');

const requiredSkills = [
  'e2e-test-help',
  'e2e-test',
  'e2e-test-author',
  'e2e-test-review',
  'e2e-test-repair',
];

const errors = [];

const requiredStages = [
  'inspect', 'assess', 'design', 'compose',
  'review-core', 'repair-core', 'reconcile', 'validate',
];

for (const skillName of requiredSkills) {
  const skillMd = join(skillsDir, skillName, 'SKILL.md');

  try {
    statSync(skillMd);
  } catch {
    errors.push(`Missing: skills/${skillName}/SKILL.md`);
    continue;
  }

  const content = readFileSync(skillMd, 'utf8');

  // 检查 frontmatter
  if (!content.startsWith('---\n')) {
    errors.push(`${skillName}: SKILL.md must start with YAML frontmatter`);
    continue;
  }

  const fmEnd = content.indexOf('\n---\n', 4);
  if (fmEnd === -1) {
    errors.push(`${skillName}: SKILL.md frontmatter not closed`);
    continue;
  }

  const fm = content.slice(4, fmEnd);

  // 检查必需字段
  if (!fm.includes('name:')) {
    errors.push(`${skillName}: frontmatter missing 'name'`);
  }
  if (!fm.includes('description:')) {
    errors.push(`${skillName}: frontmatter missing 'description'`);
  }

  // 检查无 TODO 占位符
  const todoPattern = '[' + 'TODO:';
  const todoPattern2 = '[' + 'TODO]';
  if (content.includes(todoPattern) || content.includes(todoPattern2)) {
    errors.push(`${skillName}: contains TODO placeholder`);
  }
}

for (const stageName of requiredStages) {
  const skillMd = join(stagesDir, stageName, 'SKILL.md');
  try { statSync(skillMd); } catch {
    errors.push(`Missing: stages/${stageName}/SKILL.md`);
    continue;
  }
  const content = readFileSync(skillMd, 'utf8');
  if (!content.startsWith('---\n') || !content.includes('\n---\n')) errors.push(`${stageName}: internal SKILL.md frontmatter invalid`);
  if (!content.includes('不是用户入口')) errors.push(`${stageName}: must declare internal-only discovery boundary`);
}

if (errors.length > 0) {
  console.error('Skill check failed:');
  for (const err of errors) {
    console.error(`  ${err}`);
  }
  process.exit(1);
} else {
  console.log(`All ${requiredSkills.length} user skills and ${requiredStages.length} internal stage skills validated successfully.`);
}
