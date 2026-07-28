#!/usr/bin/env node

/** 精确聚合 2 宿主 × 3 包的方法正向试验与独立盲评。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { aggregateMethodForwardQualification, createForwardValidators } from './lib/method-forward-trials.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const values = flag => args.flatMap((item, index) => item === flag ? [args[index + 1]] : []).filter(Boolean);
const value = flag => values(flag)[0] || null;

try {
  const pendingPath = absolute(value('--pending'));
  const outputPath = value('--output') ? absolute(value('--output')) : null;
  const trialPaths = values('--trial').map(absolute);
  const rubricPaths = values('--rubric').map(absolute);
  const verifiedPaths = values('--verified-rubric').map(absolute);
  if (trialPaths.length !== 6 || rubricPaths.length !== 6 || verifiedPaths.length !== 6) throw coded('MFQ_COHORT_INVALID');
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const result = aggregateMethodForwardQualification({
    pendingEvidence: load(pendingPath),
    trials: trialPaths.map(load),
    rubrics: rubricPaths.map(load),
    verifiedRubrics: verifiedPaths.map(load),
    validators: createForwardValidators(pluginRoot),
  });
  const synthetic = result.diagnostics.includes('NON_CERTIFYING_SYNTHETIC_EVIDENCE');
  const output = {
    status: synthetic && result.diagnostics.every(item => item === 'NON_CERTIFYING_SYNTHETIC_EVIDENCE')
      ? 'FORWARD_INFRA_ACCEPTANCE_CANDIDATE'
      : result.evidence.qualificationStatus,
    evidence: result.evidence,
    diagnostics: result.diagnostics,
  };
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, args.includes('--json') ? 2 : 0)}\n`);
  if (!['QUALIFIED', 'FORWARD_INFRA_ACCEPTANCE_CANDIDATE'].includes(output.status)) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: codeOf(error) })}\n`);
  process.exitCode = 1;
}

function absolute(path) { if (!path || !isAbsolute(path)) throw coded('MFQ_ABSOLUTE_PATH_REQUIRED'); return resolve(path); }
function coded(code) { return Object.assign(new Error(code), { code }); }
function codeOf(error) { return String(error?.code || error?.message || 'MFQ_AGGREGATE_FAILED').match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'MFQ_AGGREGATE_FAILED'; }
