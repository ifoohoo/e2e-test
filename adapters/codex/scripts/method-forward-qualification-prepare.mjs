#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { prepareForwardTrial } from './forward-trials-prepare.mjs';
import { buildPendingMethodForwardQualification } from './lib/method-forward-qualification.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const packageIds = ['fwd-freight-customs', 'fwd-library-holds', 'fwd-ticket-escalation'];

export function preparePendingMethodQualification({ outDir }) {
  if (!outDir) throw coded('OUTPUT_REQUIRED');
  const codex = packageIds.map(packageId => prepareForwardTrial({ outDir, host: 'codex', packageId }));
  const claude = packageIds.map(packageId => prepareForwardTrial({ outDir, host: 'claude-code', packageId }));
  for (let index = 0; index < codex.length; index += 1) {
    if (codex[index].tarballDigest !== claude[index].tarballDigest || codex[index].rawInputDigest !== claude[index].rawInputDigest) {
      throw coded('HOST_PACKAGE_DRIFT');
    }
  }
  const api = JSON.parse(readFileSync(join(pluginRoot, 'authority-api', 'api.json'), 'utf8'));
  const implementation = readFileSync(join(pluginRoot, 'family', 'implementation.yaml'), 'utf8');
  const operationalPath = join(pluginRoot, 'conformance', 'behavior-qualification.json');
  const operational = existsSync(operationalPath) ? JSON.parse(readFileSync(operationalPath, 'utf8')) : null;
  const nested = (section, key) => implementation.match(new RegExp(`^${section}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, 'm'))?.[1]
    ?.match(new RegExp(`^[ \\t]+${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  const packages = codex.map(item => ({
    packageId: item.packageId,
    domain: item.domain,
    tarballDigest: item.tarballDigest,
    rawInputDigest: item.rawInputDigest,
    projectFactsDigest: item.projectFactsDigest,
    goalDigest: item.goalDigest,
    containsExpectedArtifacts: false,
  }));
  return buildPendingMethodForwardQualification({
    packages,
    evidence: {
      familyApiRevision: api.api.revisionDigest,
      contractRevision: operational?.evidence?.contractRevision || `sha256:${'0'.repeat(64)}`,
      bundleDigest: nested('bundle', 'treeDigest'),
      deterministicAttestation: nested('conformance', 'deterministicAttestation'),
      operationalQualificationDigest: operational?.digest || null,
    },
  });
}

function coded(code) { return Object.assign(new Error(code), { code }); }

if (process.argv[1]?.endsWith('method-forward-qualification-prepare.mjs')) {
  const args = process.argv.slice(2);
  const get = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  try {
    const result = preparePendingMethodQualification({ outDir: get('--out') });
    const evidenceOut = get('--evidence-out');
    if (evidenceOut) writeFileSync(evidenceOut, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: result.qualificationStatus, digest: result.digest, evidenceOut: evidenceOut || null }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: error.code || 'METHOD_FORWARD_PREPARE_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
