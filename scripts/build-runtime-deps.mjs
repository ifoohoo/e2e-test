#!/usr/bin/env node

/**
 * build-runtime-deps.mjs
 *
 * 使用 esbuild 将 ajv + ajv-formats 和 typescript 打包为自包含 ESM 运行文件，
 * 放在 scripts/runtime-deps/。生成物不含裸第三方包导入，可在无 node_modules
 * 条件下直接由 ESM 脚本通过相对路径导入。
 *
 * 用法:
 *   node scripts/build-runtime-deps.mjs          # 生成
 *   node scripts/build-runtime-deps.mjs --check  # 检查漂移
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const pluginRoot = join(import.meta.dirname, '..');
const runtimeDepsDir = join(pluginRoot, 'scripts', 'runtime-deps');
const isCheck = process.argv.includes('--check');
const moduleRequire = createRequire(import.meta.url);

// evidence-refresh release gates intentionally run this generator from a
// package copy without its own node_modules. Node can still resolve the build
// dependencies from an ancestor package root, so pass those same existing
// search roots to esbuild instead of assuming pluginRoot/node_modules exists.
const moduleSearchPaths = [...new Set(
  ['ajv', 'ajv-formats', 'typescript']
    .flatMap(packageName => moduleRequire.resolve.paths(packageName) || [])
    .filter(existsSync),
)];

function resolvePackageRoot(packageName) {
  return dirname(moduleRequire.resolve(`${packageName}/package.json`));
}

// Node.js built-in modules that are safe to leave as external imports.
// These are always available in Node.js and do not require node_modules.
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

// ─── Bundle definitions ───

const BUNDLES = [
  {
    name: 'ajv-bundle.mjs',
    entryContent: [
      '// Auto-generated entry for esbuild bundling. Do not edit.',
      'export { default } from "ajv";',
      'export { default as addFormats } from "ajv-formats";',
    ].join('\n') + '\n',
    esbuildOptions: {
      format: 'esm',
      bundle: true,
      platform: 'neutral',
      mainFields: ['module', 'main'],
      target: 'node22',
      treeShaking: true,
      minifyIdentifiers: false,
      minifySyntax: false,
      minifyWhitespace: false,
    },
  },
  {
    name: 'typescript-bundle.mjs',
    entryContent: [
      '// Auto-generated entry for esbuild bundling. Do not edit.',
      'import ts from "typescript";',
      'export default ts;',
      'export * from "typescript";',
    ].join('\n') + '\n',
    esbuildOptions: {
      format: 'esm',
      bundle: true,
      platform: 'node',
      target: 'node22',
      treeShaking: false, // typescript exports are all potentially needed
      minifyIdentifiers: false,
      minifySyntax: false,
      minifyWhitespace: false,
      // source-map-support is an optional dependency of typescript used for
      // better stack traces. Provide a no-op shim so the bundle is fully
      // self-contained without requiring the package at runtime.
      alias: {
        'source-map-support': join(import.meta.dirname, 'runtime-deps', '_noop-shim.mjs'),
      },
      // TypeScript is a CJS module that uses require() and __filename/__dirname.
      // Provide shims so these work in ESM context.
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          'import { fileURLToPath as __fileURLToPath } from "node:url";',
          'import { dirname as __dirname_of } from "node:path";',
          'const require = __createRequire(import.meta.url);',
          'const __filename = __fileURLToPath(import.meta.url);',
          'const __dirname = __dirname_of(__filename);',
        ].join(' '),
      },
    },
  },
];

const BUNDLED_LICENSES = [
  {
    packageName: 'ajv',
    source: 'https://github.com/ajv-validator/ajv',
    licenseFile: 'LICENSE',
  },
  {
    packageName: 'ajv-formats',
    source: 'https://github.com/ajv-validator/ajv-formats',
    licenseFile: 'LICENSE',
  },
  {
    packageName: 'typescript',
    source: 'https://github.com/microsoft/TypeScript',
    licenseFile: 'LICENSE.txt',
  },
];

// ─── Build logic ───

async function buildBundle(definition) {
  const { name, entryContent, esbuildOptions } = definition;
  const tmpDir = mkdtempSync(join(tmpdir(), 'runtime-deps-build-'));
  const entryFile = join(tmpDir, 'entry.mjs');
  const outFile = join(tmpDir, name);

  try {
    writeFileSync(entryFile, entryContent, 'utf8');

    // Dynamically import esbuild (it's a devDependency)
    const esbuild = await import('esbuild');

    const result = await esbuild.build({
      entryPoints: [entryFile],
      outfile: outFile,
      // esbuild otherwise derives emitted module labels from process.cwd(),
      // so maintainer calls from the workspace root and package root differ.
      absWorkingDir: pluginRoot,
      nodePaths: moduleSearchPaths,
      metafile: true,
      ...esbuildOptions,
    });

    // Verify no third-party external dependencies (only node: built-ins allowed)
    const externals = Object.keys(result.metafile.inputs).length === 0
      ? Object.keys(result.metafile.outputs).flatMap(o => result.metafile.outputs[o].imports || [])
          .filter(i => i.external).map(i => i.path)
      : [];
    // Also check from the metafile inputs for external imports
    const allExternals = new Set();
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imp of (output.imports || [])) {
        if (imp.external) allExternals.add(imp.path);
      }
    }
    for (const ext of allExternals) {
      // Allow node: prefixed modules and bare Node.js built-in module names
      if (!ext.startsWith('node:') && !NODE_BUILTINS.has(ext)) {
        console.error(`ERROR: ${name} has unexpected external dependency: ${ext}`);
        process.exit(1);
      }
    }

    const output = readFileSync(outFile, 'utf8');
    // Strip esbuild's source path comments that contain the temp directory path.
    // These are non-deterministic because the temp directory name changes each run.
    // esbuild may emit the path as absolute or relative (with ../  prefixes).
    const escapedTmpDir = tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const deterministic = output
      .replace(
        new RegExp(`^// (?:.*[/\\\\])?${escapedTmpDir.replace(/^\/+/, '')}.*$`, 'gm'),
        '',
      )
      // esbuild embeds module source labels relative to absWorkingDir. An
      // evidence-refresh package copy can resolve dependencies from the same
      // ancestor node_modules at a different relative depth; normalize that
      // label-only prefix so the generated bytes remain location-independent.
      .replace(/(?:\.\.\/)+node_modules\//g, '../../node_modules/')
      // Strip trailing whitespace from each line (public release verification)
      .replace(/[ \t]+$/gm, '')
      // Ensure file ends with exactly one newline
      .replace(/\n*$/, '\n');
    // Prepend provenance header
    const header = [
      '// ┌──────────────────────────────────────────────────────────────┐',
      '// │ This file is auto-generated by build-runtime-deps.mjs.       │',
      '// │ Do not edit manually. Run: node scripts/build-runtime-deps.mjs│',
      '// └──────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n');
    return header + deterministic;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildThirdPartyLicenses() {
  const sections = [
    'THIRD-PARTY LICENSES FOR BUNDLED RUNTIME DEPENDENCIES',
    '',
    'This file is generated by scripts/build-runtime-deps.mjs from the exact',
    'dependency versions installed by pnpm-lock.yaml. Do not edit manually.',
  ];
  for (const definition of BUNDLED_LICENSES) {
    const packageRoot = resolvePackageRoot(definition.packageName);
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const license = readFileSync(join(packageRoot, definition.licenseFile), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trimEnd();
    sections.push(
      '',
      '================================================================',
      `${definition.packageName}@${metadata.version}`,
      `Source: ${definition.source}`,
      '================================================================',
      '',
      license,
    );
  }
  return `${sections.join('\n')}\n`;
}

async function main() {
  mkdirSync(runtimeDepsDir, { recursive: true });

  let driftDetected = false;

  for (const definition of BUNDLES) {
    const outPath = join(runtimeDepsDir, definition.name);
    const content = await buildBundle(definition);

    if (isCheck) {
      try {
        const existing = readFileSync(outPath, 'utf8');
        if (existing !== content) {
          console.error(`DRIFT: scripts/runtime-deps/${definition.name}`);
          driftDetected = true;
        }
      } catch {
        console.error(`MISSING: scripts/runtime-deps/${definition.name}`);
        driftDetected = true;
      }
    } else {
      writeFileSync(outPath, content, 'utf8');
      const hash = createHash('sha256').update(content).digest('hex');
      console.log(`Generated ${definition.name} (sha256:${hash.slice(0, 16)}..., ${content.length} bytes)`);
    }
  }

  const licensePath = join(runtimeDepsDir, 'THIRD_PARTY_LICENSES.txt');
  const licenseContent = buildThirdPartyLicenses();
  if (isCheck) {
    try {
      if (readFileSync(licensePath, 'utf8') !== licenseContent) {
        console.error('DRIFT: scripts/runtime-deps/THIRD_PARTY_LICENSES.txt');
        driftDetected = true;
      }
    } catch {
      console.error('MISSING: scripts/runtime-deps/THIRD_PARTY_LICENSES.txt');
      driftDetected = true;
    }
  } else {
    writeFileSync(licensePath, licenseContent, 'utf8');
    const hash = createHash('sha256').update(licenseContent).digest('hex');
    console.log(`Generated THIRD_PARTY_LICENSES.txt (sha256:${hash.slice(0, 16)}..., ${licenseContent.length} bytes)`);
  }

  if (isCheck) {
    if (driftDetected) {
      console.error('Runtime deps drift detected. Run: node scripts/build-runtime-deps.mjs');
      process.exit(1);
    } else {
      console.log('Runtime deps check passed. No drift detected.');
    }
  }
}

main().catch(err => {
  console.error('build-runtime-deps failed:', err.message);
  process.exit(1);
});
