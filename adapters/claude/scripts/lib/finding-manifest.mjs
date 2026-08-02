import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { default as Ajv } from '../runtime-deps/ajv-bundle.mjs';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function rulesDigest(rules) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(rules))).digest('hex')}`;
}

export function loadFindingManifest(pluginRoot) {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'assets', 'finding-capability-manifest.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(join(pluginRoot, 'schemas', 'finding-capability-manifest.json'), 'utf8'));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  if (!validate(manifest)) throw new Error(`MANIFEST_SCHEMA_INVALID:${JSON.stringify(validate.errors)}`);
  const digest = rulesDigest(manifest.rules);
  if (manifest.digest !== digest) throw new Error('MANIFEST_DIGEST_MISMATCH');
  return { rules: new Map(manifest.rules.map(rule => [rule.rule, rule])), digest, manifest };
}

export function loadFindingCatalog(pluginRoot) {
  const markdown = readFileSync(join(pluginRoot, 'references', 'findings-catalog.md'), 'utf8');
  const sections = markdown.split(/^## /m).slice(1);
  const catalog = new Map();
  for (const section of sections) {
    const rule = section.match(/^(E2E-F-\d{3}):/)?.[1];
    if (!rule) continue;
    const severity = section.match(/\| severity \| ([^|]+) \|/)?.[1]?.trim();
    const repairability = section.match(/\| repairability \| ([^|]+) \|/)?.[1]?.trim();
    catalog.set(rule, { severity, repairability });
  }
  return catalog;
}

export function assertManifestHandlerConsistency(manifestInput, { handlers, repairHandlers }) {
  const rules = manifestInput instanceof Map ? manifestInput : new Map(manifestInput.rules.map(rule => [rule.rule, rule]));
  const manifestWithoutHandler = [];
  const handlerWithoutManifest = [];
  const repairabilityMismatch = [];
  for (const [rule, capability] of rules) {
    const hasHandler = Object.hasOwn(handlers, rule);
    const shouldHaveHandler = capability.status !== 'planned';
    if (shouldHaveHandler !== hasHandler || (hasHandler && !capability.handler)) manifestWithoutHandler.push(rule);
    if (!shouldHaveHandler && capability.handler !== null) manifestWithoutHandler.push(rule);
    const hasRepair = Object.hasOwn(repairHandlers, rule);
    if (hasRepair && (capability.repairability !== 'safe-fix' || !capability.repairHandler)) repairabilityMismatch.push(rule);
    if (!hasRepair && capability.repairHandler !== null) repairabilityMismatch.push(rule);
  }
  for (const rule of Object.keys(handlers)) if (!rules.has(rule)) handlerWithoutManifest.push(rule);
  for (const rule of Object.keys(repairHandlers)) if (!rules.has(rule)) handlerWithoutManifest.push(rule);
  return {
    consistent: manifestWithoutHandler.length === 0 && handlerWithoutManifest.length === 0 && repairabilityMismatch.length === 0,
    manifestWithoutHandler: [...new Set(manifestWithoutHandler)],
    handlerWithoutManifest: [...new Set(handlerWithoutManifest)],
    repairabilityMismatch: [...new Set(repairabilityMismatch)],
  };
}

export function assertCatalogConsistency(manifestInput, catalog) {
  const rules = manifestInput instanceof Map ? manifestInput : new Map(manifestInput.rules.map(rule => [rule.rule, rule]));
  const mismatches = [];
  for (const [rule, capability] of rules) {
    const item = catalog.get(rule);
    if (!item || item.severity !== capability.severity || item.repairability !== capability.repairability) mismatches.push(rule);
  }
  for (const rule of catalog.keys()) if (!rules.has(rule)) mismatches.push(rule);
  return { consistent: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

export function stableBlocked(manifestInput) {
  const rules = manifestInput instanceof Map ? [...manifestInput.values()] : manifestInput.rules;
  return rules.some(rule => rule.stableBlocker === true);
}
