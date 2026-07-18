# e2e-test Installation

## Prerequisites

- Node.js >= 22
- pnpm or npm
- One of: [Codex](https://codex.ai), [Claude Code](https://claude.ai/code)

## Install via npm

```bash
npm install e2e-test
```

## Install as Codex Plugin

1. Copy `.codex-plugin/plugin.json` to your project's `.codex-plugin/` directory.
2. The plugin will be discovered on next Codex session start.

## Install as Claude Code Marketplace Plugin

1. Copy `.claude-plugin/marketplace.json` to your project's `.claude-plugin/` directory.
2. Restart Claude Code to discover the plugin.

## Verify Installation

```bash
# Check Gate A status
node node_modules/e2e-test/scripts/gate-status.mjs --json
```

## Current Gate A Behavior

After installation:

- `e2e-test-help` is available as a read-only diagnostic skill.
- `e2e-test`, `e2e-test-author`, `e2e-test-review`, `e2e-test-repair` return `NOT_IMPLEMENTED` or `GATE_B_REQUIRED`.
- The plugin is **not enabled by default** and does not replace `artifact-chain-assistant` generic `e2e`.
- No provider catalog is emitted. No registry binding is created.

## What's Next

- Run `e2e-test-help` to see the full capability inventory.
- See `CHANGELOG.md` for release history.
- Gate B will enable experimental/prerelease provider with deterministic conformance.
