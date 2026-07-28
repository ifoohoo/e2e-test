import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

const cache = { path: null, checked: false };

export function validateArtifactContract(pluginRoot, artifact, contractId) {
  const cli = findArtifactGraphCli(pluginRoot);
  if (!cli) return unavailable();
  try {
    const stdout = execFileSync(process.execPath, [
      cli, 'contract', 'validate', '--contract', contractId,
      '--data', JSON.stringify(artifact), '--format', 'json',
    ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const data = JSON.parse(stdout);
    return { valid: data.ok === true, method: 'artifact-graph-cli', errors: data.errors || data.error || null };
  } catch (error) {
    let data = null;
    try { data = JSON.parse(String(error?.stdout || '')); } catch {}
    if (!data) return unavailable();
    return {
      valid: false,
      method: 'artifact-graph-cli',
      errors: data?.errors || (data?.error ? [data.error] : [{ code: 'ARTIFACT_GRAPH_VALIDATION_FAILED' }]),
    };
  }
}

function findArtifactGraphCli(pluginRoot) {
  if (cache.checked) return cache.path;
  cache.checked = true;
  const candidates = [];
  const explicit = process.env.E2E_TEST_ARTIFACT_GRAPH_COMMAND;
  if (explicit && isAbsolute(explicit)) candidates.push(explicit);
  try {
    const require = createRequire(join(pluginRoot, 'package.json'));
    candidates.push(join(dirname(require.resolve('artifact-graph')), 'cli.js'));
  } catch {}
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      cache.path = realpathSync(candidate);
      return cache.path;
    } catch {}
  }
  return null;
}

function unavailable() {
  return { valid: false, method: 'unavailable', errors: [{ code: 'ARTIFACT_GRAPH_UNAVAILABLE' }] };
}
