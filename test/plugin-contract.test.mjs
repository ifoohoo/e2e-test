import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = join(import.meta.dirname, '..');

describe('plugin contract', () => {
  it('package.json has correct name and version', () => {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'e2e-test');
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.private, false);
    assert.equal(pkg.license, 'Apache-2.0');
  });

  it('.codex-plugin/plugin.json uses platform-standard shape', () => {
    const plugin = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'e2e-test');
    assert.equal(plugin.version, '0.1.0');
    assert.ok(typeof plugin.description === 'string' && plugin.description.length > 0, 'Must have description');

    // author must be an object
    assert.ok(typeof plugin.author === 'object' && plugin.author !== null, 'author must be an object');
    assert.ok(typeof plugin.author.name === 'string', 'author.name must be a string');

    // license and keywords
    assert.equal(plugin.license, 'Apache-2.0');
    assert.ok(Array.isArray(plugin.keywords), 'keywords must be an array');

    // skills must be a string path, not an array
    assert.equal(plugin.skills, './skills/', 'skills must be "./skills/"');

    // interface must be an object with platform-standard fields
    assert.ok(typeof plugin.interface === 'object' && plugin.interface !== null, 'interface must be an object');
    assert.ok(typeof plugin.interface.displayName === 'string' && plugin.interface.displayName.length > 0, 'interface.displayName must be a non-empty string');
    assert.ok(typeof plugin.interface.shortDescription === 'string' && plugin.interface.shortDescription.length > 0, 'interface.shortDescription must be a non-empty string');
    assert.ok(typeof plugin.interface.developerName === 'string', 'interface.developerName must be a string');
    assert.ok(typeof plugin.interface.category === 'string', 'interface.category must be a string');
    assert.ok(typeof plugin.interface.defaultPrompt === 'string' || typeof plugin.interface.default_prompt === 'string', 'interface must have defaultPrompt');
    assert.ok(Array.isArray(plugin.interface.capabilities), 'interface.capabilities must be an array');
    assert.ok(typeof plugin.interface.longDescription === 'string' && plugin.interface.longDescription.length > 0, 'interface.longDescription must be a non-empty string');

    // must NOT have non-standard fields
    assert.equal(plugin.experimental, undefined, 'Must not have experimental field');
    assert.equal(plugin.gate, undefined, 'Must not have gate field');
    assert.ok(!Array.isArray(plugin.skills), 'skills must not be an array');
  });

  it('.claude-plugin/marketplace.json uses owner/plugins/source structure', () => {
    const marketplace = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'e2e-test');
    assert.equal(marketplace.owner.name, 'mzdbxqh');
    assert.ok(Array.isArray(marketplace.plugins), 'Must have plugins array');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'e2e-test');
    assert.equal(marketplace.plugins[0].source, './adapters/claude');
    assert.equal(marketplace.plugins[0].version, '0.1.0');
    assert.equal(marketplace.plugins[0].license, 'Apache-2.0');
    assert.equal(marketplace.plugins[0].repository, 'https://github.com/mzdbxqh/e2e-test');
    assert.equal(marketplace.plugins[0].author.name, 'mzdbxqh');

    // must NOT have non-standard top-level fields
    assert.equal(marketplace.experimental, undefined, 'marketplace must not have experimental');
    assert.equal(marketplace.skills, undefined, 'marketplace must not have skills');
  });

  it('adapters/claude/.claude-plugin/plugin.json is valid', () => {
    const plugin = JSON.parse(readFileSync(join(pluginRoot, 'adapters/claude/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'e2e-test');
    assert.equal(plugin.version, '0.1.0');
    assert.ok(typeof plugin.author === 'object', 'adapter author must be an object');
    assert.equal(plugin.skills, './skills/', 'adapter skills must point to ./skills/');
  });

  it('LICENSE is Apache-2.0', () => {
    const license = readFileSync(join(pluginRoot, 'LICENSE'), 'utf8');
    assert.ok(license.includes('Apache License'));
    assert.ok(license.includes('Version 2.0'));
  });

  it('NOTICE references copyright', () => {
    const notice = readFileSync(join(pluginRoot, 'NOTICE'), 'utf8');
    assert.ok(notice.includes('e2e-test'));
    assert.ok(notice.includes('Apache License'));
  });
});
