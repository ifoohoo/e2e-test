import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');

describe('package content', () => {
  it('no absolute paths in any text file', () => {
    const violations = collectViolations(pluginRoot, (content, relPath) => {
      if (/\/Users\/[^/\s]+\//.test(content)) return 'absolute path';
      return null;
    });
    assert.deepEqual(violations, []);
  });

  it('no parent repo identifier', () => {
    const violations = collectViolations(pluginRoot, (content, relPath) => {
      if (/e2e-test-parent/.test(content)) return 'parent repo identifier';
      return null;
    });
    assert.deepEqual(violations, []);
  });

  it('no internal planning/review references', () => {
    const violations = collectViolations(pluginRoot, (content, relPath) => {
      if (/docs\/planning\//.test(content)) return 'internal planning reference';
      if (/docs\/reviews\//.test(content)) return 'internal reviews reference';
      if (/artifacts\/design\//.test(content)) return 'internal design reference';
      return null;
    });
    assert.deepEqual(violations, []);
  });

  it('no TODO placeholders', () => {
    const todoMarker = '[' + 'TODO:';
    const todoMarker2 = '[' + 'TODO]';
    const violations = collectViolations(pluginRoot, (content, relPath) => {
      if (content.includes(todoMarker) || content.includes(todoMarker2)) return 'TODO placeholder';
      return null;
    });
    assert.deepEqual(violations, []);
  });

  it('no forbidden directory artifacts/design', () => {
    try {
      statSync(join(pluginRoot, 'artifacts'));
      assert.fail('artifacts/ should not exist in public package');
    } catch {
      // OK
    }
  });

  it('no forbidden directory docs/planning', () => {
    try {
      statSync(join(pluginRoot, 'docs', 'planning'));
      assert.fail('docs/planning/ should not exist in public package');
    } catch {
      // OK
    }
  });

  it('no forbidden directory docs/reviews', () => {
    try {
      statSync(join(pluginRoot, 'docs', 'reviews'));
      assert.fail('docs/reviews/ should not exist in public package');
    } catch {
      // OK
    }
  });

  it('no forbidden directory runs', () => {
    try {
      statSync(join(pluginRoot, 'runs'));
      assert.fail('runs/ should not exist in public package');
    } catch {
      // OK
    }
  });
});

function collectViolations(dir, checkFn) {
  const violations = [];
  const textExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.mjs', '.js', '.txt']);

  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, and test/ (contains negative fixtures with forbidden patterns)
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test') continue;
        walk(fullPath);
      } else {
        const ext = fullPath.slice(fullPath.lastIndexOf('.'));
        if (!textExtensions.has(ext)) continue;
        try {
          const content = readFileSync(fullPath, 'utf8');
          const violation = checkFn(content, relative(dir, fullPath));
          if (violation) {
            violations.push(`${relative(dir, fullPath)}: ${violation}`);
          }
        } catch {
          // skip unreadable
        }
      }
    }
  }

  walk(dir);
  return violations;
}
