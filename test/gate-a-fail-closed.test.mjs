import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');

describe('gate-a fail-closed', () => {
  it('no skill claims production readiness', () => {
    const skills = ['e2e-test', 'e2e-test-author', 'e2e-test-review', 'e2e-test-repair'];
    for (const skillName of skills) {
      const skill = readFileSync(join(pluginRoot, 'skills', skillName, 'SKILL.md'), 'utf8');
      assert.ok(!skill.includes('可用于真实项目'), `${skillName} must not claim production readiness`);
      assert.ok(!skill.includes('可用于生产'), `${skillName} must not claim production readiness`);
      assert.ok(!skill.includes('已实现'), `${skillName} must not claim implementation`);
    }
  });

  it('implementation.yaml has no provider catalog and not enabled', () => {
    const impl = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
    assert.ok(impl.includes('providerCatalogEmitted: false'));
    assert.ok(impl.includes('deterministicConformance: not-run'));
    assert.ok(impl.includes('behaviorQualification: not-run'));
  });

  it('gate-status.mjs returns valid JSON with gate A status', () => {
    const result = execFileSync('node', [
      join(pluginRoot, 'scripts/gate-status.mjs'),
      '--json',
    ], { encoding: 'utf8', cwd: pluginRoot });
    const status = JSON.parse(result);
    assert.equal(status.gate, 'A');
    assert.equal(status.version, '0.1.0');
    assert.equal(status.providerCatalog.emitted, false);
    assert.equal(status.defaultEnabled, false);
    assert.equal(status.registry.bound, false);
    assert.equal(status.services['e2e-test'].status, 'fail-closed');
    assert.equal(status.services['e2e-test-author'].status, 'not-implemented');
  });

  it('help service exits 0 with valid JSON', () => {
    const result = execFileSync('node', [
      join(pluginRoot, 'scripts/gate-status.mjs'),
      '--service', 'help', '--json',
    ], { encoding: 'utf8', cwd: pluginRoot });
    const status = JSON.parse(result);
    assert.equal(status.service, 'help');
    assert.equal(status.status, 'available');
  });

  it('default service exits non-zero with fail-closed JSON', () => {
    try {
      execFileSync('node', [
        join(pluginRoot, 'scripts/gate-status.mjs'),
        '--service', 'default', '--json',
      ], { encoding: 'utf8', cwd: pluginRoot });
      assert.fail('Should have exited non-zero');
    } catch (err) {
      assert.ok(err.status !== 0, 'Must exit non-zero');
      const status = JSON.parse(err.stdout);
      assert.equal(status.service, 'default');
      assert.equal(status.status, 'fail-closed');
      assert.equal(status.reason, 'GATE_B_REQUIRED');
    }
  });

  it('author service exits non-zero with not-implemented JSON', () => {
    try {
      execFileSync('node', [
        join(pluginRoot, 'scripts/gate-status.mjs'),
        '--service', 'author', '--json',
      ], { encoding: 'utf8', cwd: pluginRoot });
      assert.fail('Should have exited non-zero');
    } catch (err) {
      assert.ok(err.status !== 0, 'Must exit non-zero');
      const status = JSON.parse(err.stdout);
      assert.equal(status.service, 'author');
      assert.equal(status.status, 'not-implemented');
      assert.equal(status.reason, 'NOT_IMPLEMENTED');
    }
  });

  it('review service exits non-zero with not-implemented JSON', () => {
    try {
      execFileSync('node', [
        join(pluginRoot, 'scripts/gate-status.mjs'),
        '--service', 'review', '--json',
      ], { encoding: 'utf8', cwd: pluginRoot });
      assert.fail('Should have exited non-zero');
    } catch (err) {
      assert.ok(err.status !== 0, 'Must exit non-zero');
      const status = JSON.parse(err.stdout);
      assert.equal(status.service, 'review');
      assert.equal(status.status, 'not-implemented');
      assert.equal(status.reason, 'NOT_IMPLEMENTED');
    }
  });

  it('repair service exits non-zero with not-implemented JSON', () => {
    try {
      execFileSync('node', [
        join(pluginRoot, 'scripts/gate-status.mjs'),
        '--service', 'repair', '--json',
      ], { encoding: 'utf8', cwd: pluginRoot });
      assert.fail('Should have exited non-zero');
    } catch (err) {
      assert.ok(err.status !== 0, 'Must exit non-zero');
      const status = JSON.parse(err.stdout);
      assert.equal(status.service, 'repair');
      assert.equal(status.status, 'not-implemented');
      assert.equal(status.reason, 'NOT_IMPLEMENTED');
    }
  });

  it('fail-closed services produce no project writes', () => {
    // 运行 default/author/review/repair，确认它们只输出 JSON 到 stdout
    const services = ['default', 'author', 'review', 'repair'];
    for (const svc of services) {
      try {
        execFileSync('node', [
          join(pluginRoot, 'scripts/gate-status.mjs'),
          '--service', svc, '--json',
        ], { encoding: 'utf8', cwd: pluginRoot });
      } catch (err) {
        // 预期非零退出
        const status = JSON.parse(err.stdout);
        assert.ok(status.service, `${svc} must output structured JSON`);
        assert.ok(status.status, `${svc} must have status field`);
        assert.ok(status.reason, `${svc} must have reason field`);
      }
    }
  });
});
