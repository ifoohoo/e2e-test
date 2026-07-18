# e2e-test

Experimental E2E test skill family — framework-neutral E2E specification authoring, review, repair and proof reconcile.

## Status

**Gate A (Skeleton)** — This is an experimental skill family under development.

- `e2e-test-help`: Read-only diagnostic entry point. Available.
- `e2e-test`, `e2e-test-author`, `e2e-test-review`, `e2e-test-repair`: Fail-closed contract placeholders. Not implemented.
- No provider catalog. Not enabled by default.
- Does not replace `artifact-chain-assistant` generic `e2e`.

## Installation

```bash
# npm (future)
npm install e2e-test

# Codex plugin
# Copy .codex-plugin/plugin.json to your project

# Claude Code
# See INSTALL.md for marketplace setup
```

## Quick Start

```bash
# Check Gate A status
node scripts/gate-status.mjs --json
```

## Architecture

This family implements the E2E Test Skill Family API defined by `artifact-chain-assistant`:

- Conforms to Artifact Contract `artifact.e2e-test@1` (draft)
- Implements Family API `artifact.e2e-test-family@1` (draft)
- Atomic binding: default (no mixSafe)
- Maturity: experimental

## License

Apache-2.0
