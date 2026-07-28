#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { stableDigest } from './lib/digest.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const fixturesRoot = join(pluginRoot, 'fixtures', 'forward-trials');
const forbiddenNames = [/inspection/i, /candidate-assessment/i, /matrix/i, /^TC-/i];
const forbiddenContent = [/\bINSPECT-/i, /\bASSESS-/i, /\bMATRIX-/i, /\bTC-\d/i, /期望答案/, /expected answer/i];

export function prepareForwardTrial({ outDir, host, packageId }) {
  if (!['codex', 'claude-code'].includes(host)) throw coded('INVALID_HOST');
  if (!/^fwd-[a-z0-9-]+$/.test(packageId || '')) throw coded('INVALID_PACKAGE');
  const packageRoot = join(fixturesRoot, packageId);
  const rawRoot = join(packageRoot, 'raw');
  if (!existsSync(rawRoot)) throw coded('PACKAGE_NOT_FOUND');
  const sourceManifest = JSON.parse(readFileSync(join(packageRoot, 'package.manifest.json'), 'utf8'));
  const files = Object.fromEntries(readdirSync(rawRoot).sort().map(name => [`raw/${name}`, readFileSync(join(rawRoot, name))]));
  files['START.md'] = Buffer.from('# 启动说明\n\n读取 raw 目录中的原始需求、场景、项目事实和目标，从 e2e-test-author 用户入口开始。默认只生成预览，未经明确授权不得提交目标项目。\n');
  assertNoForbidden(files);
  const tar = createTar(files);
  mkdirSync(outDir, { recursive: true });
  const tarPath = join(outDir, `${packageId}-${host}.tar`);
  writeFileSync(tarPath, tar);
  const manifest = {
    packageId, host, domain: sourceManifest.domain,
    tarballDigest: bytesDigest(tar),
    rawInputDigest: stableDigest(Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('raw/')).map(([name, bytes]) => [basename(name), bytesDigest(bytes)]))),
    projectFactsDigest: bytesDigest(files['raw/project-facts.json']),
    goalDigest: bytesDigest(files['raw/goal.md']),
    containsExpectedArtifacts: false,
    forbiddenScan: 'PASS',
  };
  writeFileSync(join(outDir, `${packageId}-${host}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function assertNoForbidden(files) {
  for (const [name, bytes] of Object.entries(files)) {
    if (forbiddenNames.some(pattern => pattern.test(basename(name)))) throw coded('PREPARE_FORBIDDEN_CONTENT');
    const content = bytes.toString('utf8');
    if (forbiddenContent.some(pattern => pattern.test(content))) throw coded('PREPARE_FORBIDDEN_CONTENT');
    if (/\/(?:Users|home|root)\//.test(content) || /[A-Za-z]:\\/.test(content)) throw coded('PREPARE_FORBIDDEN_CONTENT');
  }
}

export function createTar(files) {
  const chunks = [];
  for (const [name, contentValue] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const content = Buffer.from(contentValue);
    const header = Buffer.alloc(512, 0);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeString(header, 257, 6, 'ustar');
    writeString(header, 263, 2, '00');
    writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    chunks.push(header, content);
    const padding = (512 - content.length % 512) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(text, offset, length, 'ascii');
}

function bytesDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function coded(code) { return Object.assign(new Error(code), { code }); }

if (process.argv[1]?.endsWith('forward-trials-prepare.mjs')) {
  const args = process.argv.slice(2);
  const get = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  try {
    const result = prepareForwardTrial({ outDir: get('--out'), host: get('--host') || 'codex', packageId: get('--package') });
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${result.packageId}: PREPARED\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: error.code || 'PREPARE_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
