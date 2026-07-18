import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const pluginRoot = join(import.meta.dirname, '..');

/**
 * 验证 gate-status.mjs 可从无关临时 cwd 执行
 */
function testGateStatusFromTmpCwd(scriptPath, label) {
  // 创建临时目录作为无关 cwd
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-test-portability-'));

  try {
    // help 服务应退出 0
    const helpResult = execFileSync('node', [
      scriptPath,
      '--service', 'help', '--json',
    ], { encoding: 'utf8', cwd: tmpDir });
    const helpStatus = JSON.parse(helpResult);
    assert.equal(helpStatus.service, 'help');
    assert.equal(helpStatus.status, 'available');

    // default/author/review/repair 应输出合法 JSON 且非零退出
    const failServices = ['default', 'author', 'review', 'repair'];
    for (const svc of failServices) {
      try {
        execFileSync('node', [
          scriptPath,
          '--service', svc, '--json',
        ], { encoding: 'utf8', cwd: tmpDir });
        assert.fail(`${label}: ${svc} should exit non-zero`);
      } catch (err) {
        assert.ok(err.status !== 0, `${label}: ${svc} must exit non-zero`);
        const status = JSON.parse(err.stdout);
        assert.ok(status.service, `${label}: ${svc} must have service field`);
        assert.ok(status.status, `${label}: ${svc} must have status field`);
        assert.ok(status.reason, `${label}: ${svc} must have reason field`);
      }
    }

    // 验证临时目录无写入
    const afterFiles = readdirSync(tmpDir);
    assert.equal(afterFiles.length, 0, `${label}: temp dir should have no files after execution`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('adapter portability', () => {
  it('root plugin gate-status.mjs works from unrelated cwd', () => {
    const scriptPath = join(pluginRoot, 'scripts', 'gate-status.mjs');
    testGateStatusFromTmpCwd(scriptPath, 'root plugin');
  });

  it('codex adapter gate-status.mjs works from unrelated cwd', () => {
    const scriptPath = join(pluginRoot, 'adapters', 'codex', 'scripts', 'gate-status.mjs');
    testGateStatusFromTmpCwd(scriptPath, 'codex adapter');
  });

  it('claude adapter gate-status.mjs works from unrelated cwd', () => {
    const scriptPath = join(pluginRoot, 'adapters', 'claude', 'scripts', 'gate-status.mjs');
    testGateStatusFromTmpCwd(scriptPath, 'claude adapter');
  });

  it('adapter rebuild produces no drift', () => {
    // 第一次构建
    execFileSync('node', [
      join(pluginRoot, 'scripts', 'build-adapters.mjs'),
    ], { encoding: 'utf8', cwd: pluginRoot });

    // 第二次构建（检查模式）应无漂移
    const checkResult = execFileSync('node', [
      join(pluginRoot, 'scripts', 'build-adapters.mjs'),
      '--check',
    ], { encoding: 'utf8', cwd: pluginRoot });
    assert.ok(checkResult.includes('No drift'), `Expected no drift, got: ${checkResult}`);
  });
});
