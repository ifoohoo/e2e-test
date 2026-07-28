#!/usr/bin/env node

/**
 * stage-runner.mjs
 *
 * DIRECT STAGE DISABLED in trust kernel cycle.
 *
 * Public skills must not guide users to run stage-runner.mjs directly.
 * All stage execution must go through service-runner.mjs which enforces
 * the Registry preflight chain. This script returns DIRECT_STAGE_DISABLED
 * for all invocations to prevent bypassing the service entry.
 *
 * R5: Structured diagnostics only — no raw messages, no path sanitization.
 */

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; };

const stage = getArg('stage') || 'unknown';

// All direct stage invocations are blocked.
// Stage execution must go through service-runner preflight → run-lock reverify.
const output = {
  stage,
  status: 'DIRECT_STAGE_DISABLED',
  code: 'DIRECT_STAGE_ENTRY_BLOCKED',
  diagnostics: [{ code: 'DIRECT_STAGE_ENTRY_BLOCKED', severity: 'error' }],
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  process.stdout.write(`Stage: ${stage}\nStatus: DIRECT_STAGE_DISABLED\nCode: DIRECT_STAGE_ENTRY_BLOCKED\n`);
}
process.exit(1);
