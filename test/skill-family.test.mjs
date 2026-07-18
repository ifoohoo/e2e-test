import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');

const requiredSkills = [
  'e2e-test-help',
  'e2e-test',
  'e2e-test-author',
  'e2e-test-review',
  'e2e-test-repair',
];

describe('skill family', () => {
  for (const skillName of requiredSkills) {
    it(`${skillName}/SKILL.md exists and has valid frontmatter`, () => {
      const skillMd = join(pluginRoot, 'skills', skillName, 'SKILL.md');
      const content = readFileSync(skillMd, 'utf8');

      assert.ok(content.startsWith('---\n'), 'Must start with frontmatter');

      const fmEnd = content.indexOf('\n---\n', 4);
      assert.ok(fmEnd > 0, 'Frontmatter must be closed');

      const fm = content.slice(4, fmEnd);
      assert.ok(fm.includes('name:'), `${skillName} frontmatter must have 'name'`);
      assert.ok(fm.includes('description:'), `${skillName} frontmatter must have 'description'`);

      // 平台不接受的 frontmatter key
      assert.ok(!fm.includes('argument-hint:'), `${skillName} frontmatter must not have 'argument-hint'`);
      assert.ok(!fm.includes('disable-model-invocation:'), `${skillName} frontmatter must not have 'disable-model-invocation'`);

      // 无 TODO
      const todoMarker = '[' + 'TODO:';
      assert.ok(!content.includes(todoMarker), `${skillName} must not contain TODO placeholders`);
    });
  }

  it('implementation.yaml exists and has required fields', () => {
    const impl = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
    assert.ok(impl.includes('schemaVersion:'), 'Must have schemaVersion');
    assert.ok(impl.includes('id: e2e-test'), 'Must have implementation id');
    assert.ok(impl.includes('maturity: experimental'), 'Must be experimental');
    assert.ok(impl.includes('mixSafe: false'), 'Must have mixSafe: false');
    assert.ok(impl.includes('providerCatalogEmitted: false'), 'Must not emit provider catalog');
  });

  it('implementation.yaml does not declare accepts/produces (Family API authority)', () => {
    const impl = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
    assert.ok(!impl.includes('accepts:'), 'Must not declare accepts (belongs to Family API)');
    assert.ok(!impl.includes('produces:'), 'Must not declare produces (belongs to Family API)');
  });

  it('implementation.yaml does not declare artifact contract versions', () => {
    const impl = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
    assert.ok(!impl.includes('artifactContracts:'), 'Must not list artifact contracts (not run yet)');
  });
});
