# e2e-test

Experimental E2E test skill family — framework-neutral E2E specification authoring, review, repair and proof reconcile.

## Status

**Experimental candidate** — five services have a verified operational skeleton. Operational, method-forward, and release-artifact qualifications are separate evidence domains and do not imply one another.

- `e2e-test-help`: Read-only diagnostic entry point. Available.
- `e2e-test`, `e2e-test-author`, `e2e-test-review`, `e2e-test-repair`: fail-closed when not enabled. Author and repair default to preview and require explicit user confirmation plus a one-time handle before commit.
- Method-forward qualification remains `FORWARD_TRIALS_PENDING_CODEX` until genuine trials on both hosts complete; release-artifact certification is `null`.
- Finding capability is authoritative only in `assets/finding-capability-manifest.json`; E2E-F-002, E2E-F-006, and E2E-F-010 are now `implemented` (generic semantic detector + structured reviewer packet, not fixture-name hardcoded), so they no longer block stable maturity; forward 6+6+6 qualification is pending, so deterministic/stable is not claimed.
- Default **NOT_ENABLED**: requires explicit project binding to activate.
- v0.2.0-alpha.4 is the current GitHub prerelease (PUBLIC_RELEASE_READY); alpha.1, alpha.2, and alpha.3 are prior prereleases. Unified-marketplace availability is governed independently. Registry 0.2 formal public release and E2E Test Gate B formal public release (RELEASE_ATTESTED) remain separate subsequent milestones; alpha.4 does not equal RELEASE_ATTESTED.
- `artifact.e2e-test.browser.implement` and `artifact.e2e-test.browser.execute` are experimentally callable under explicit ExtensionBinding; default NOT_ENABLED.
- Does not replace `artifact-chain-assistant` generic `e2e`.

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** v0.2.0-alpha.4 is the current GitHub prerelease
> (PUBLIC_RELEASE_READY); unified-marketplace availability is governed
> independently. v0.2.0-alpha.1, alpha.2, and alpha.3 are prior prereleases. Gate B
> operational qualification is `CANDIDATE_QUALIFIED`, **not
> `RELEASE_ATTESTED`**; method-forward qualification remains
> `FORWARD_TRIALS_PENDING_CODEX` (real dual-host trials incomplete);
> release-artifact certification is `null`. The family defaults to
> `NOT_ENABLED` and fails closed without explicit project binding. alpha.4
> does not equal Gate B RELEASE_ATTESTED — do not treat this prerelease as the
> formal Gate B release. implement/execute are experimentally callable under
> explicit ExtensionBinding; default NOT_ENABLED.

<!-- release-skill:capability:safe-first-command -->
> **Start here:** the safe read-only entry is the `e2e-test-help` diagnostic
> skill. It shows current Gate B status and capabilities without writing
> files or triggering external actions. Run `e2e-test-help` first to
> understand the current state after installation. The remaining services
> (`e2e-test-author`, `e2e-test-review`, `e2e-test-repair`) default to
> `NOT_ENABLED` and require explicit project binding before use.

## Installation

npm installation is not supported — this plugin is distributed exclusively through the unified marketplace. Use the Claude Code or Codex marketplace commands below to install.

Install from the unified marketplace `ifoohoo/artifact-skill-set`:

```bash
# Claude Code — install from marketplace
claude plugin marketplace add ifoohoo/artifact-skill-set
claude plugin install e2e-test@artifact-skill-set

# Codex — install from marketplace
codex plugin marketplace add ifoohoo/artifact-skill-set --ref main
codex plugin add e2e-test@artifact-skill-set
```

See [INSTALL.md](INSTALL.md) for detailed instructions.

## Quick Start

```bash
# Check Gate B status
node scripts/gate-status.mjs --json
```

## Minimal Example

After installation, run the read-only diagnostic to inspect current Gate B status and capabilities. This does not write files or trigger external actions.

```bash
# Run the e2e-test-help diagnostic (read-only, safe first step)
e2e-test-help
```

`e2e-test-help` is the only always-available entry point. The remaining services (`e2e-test-author`, `e2e-test-review`, `e2e-test-repair`) default to `NOT_ENABLED` and require explicit project binding before they become active — see [INSTALL.md](INSTALL.md) for binding instructions.

## Troubleshooting

Common failure modes and their meaning:

- **NOT_ENABLED (fail-closed)**: If a service fails with `NOT_ENABLED`, this is expected behavior — `e2e-test-author`, `e2e-test-review`, and `e2e-test-repair` require explicit project binding. Complete binding per INSTALL.md, then retry.
- **Gate B candidate state**: `e2e-test-help` reports current qualification status. If it shows `CANDIDATE_QUALIFIED` (not `RELEASE_ATTESTED`) or method-forward qualification as `FORWARD_TRIALS_PENDING_CODEX`, these are known states of the current Gate B candidate phase — not errors.
- **If a service execution fails**: first inspect the `e2e-test-help` diagnostic output and the conformance / behavior-qualification evidence state. Do not manually modify gate, attestation, or evidence files.
- **GATE_FAILED / PARTIAL**: gate result codes indicating manual investigation is required. Do not auto-override or tamper with evidence artifacts.

## Architecture

This family implements the E2E Test Skill Family API defined by `artifact-chain-assistant`:

- Conforms to Artifact Contract `artifact.e2e-test@1`
- Implements Family API `artifact.e2e-test-family@1`
- Atomic binding: default (no mixSafe)
- Lifecycle: independent / experimental; catalog channel is separate from maturity

## License

Apache-2.0
