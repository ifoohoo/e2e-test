# e2e-test

Experimental E2E test skill family — framework-neutral E2E specification authoring, review, repair and proof reconcile.

## Status

**Stable** — the specification kernel (help/default/author/review/repair) is stable with CANDIDATE_QUALIFIED qualification. The browser extension (implement/execute) remains experimental. Operational, method-forward, and release-artifact qualifications are separate evidence domains and do not imply one another.

- `e2e-test-help`: Read-only diagnostic entry point. Available.
- `e2e-test`, `e2e-test-author`, `e2e-test-review`, `e2e-test-repair`: stable; fail-closed when not enabled. Author and repair default to preview and require explicit user confirmation plus a one-time handle before commit.
- `e2e-test-implement`, `e2e-test-execute`: **experimental** browser extension skills, fail-closed when not enabled. Require explicit `ExtensionBinding`. Default NOT_ENABLED.
- Method-forward qualification remains `FORWARD_TRIALS_PENDING_CODEX` until genuine trials on both hosts complete; release-artifact certification is `null`.
- Finding capability is authoritative only in `assets/finding-capability-manifest.json`; E2E-F-002, E2E-F-006, and E2E-F-010 are `implemented` (generic semantic detector + structured reviewer packet, not fixture-name hardcoded).
- Default **NOT_ENABLED**: requires explicit project binding to activate.
- v0.2.1 is the current stable release. It closes Git marketplace runtime dependencies with self-contained Ajv and TypeScript bundles, so fresh Claude/Codex installs do not require a repository-local `node_modules`. The Claude/Codex unified marketplace distribution path was previously verified; v0.2.1 post-release installation verification is part of this release transaction. The Gate B Registry prerequisite is frozen to `agent-method-registry@0.2.2` (GitHub tag `agent-method-registry-v0.2.2`, commit `2d15ae574e122c5dfabf245680b5a8de628d27e4`, npm integrity `sha512-uQbsnVLBkm2yeEIHdtHu8NUjgDgheYvNF8wZfvHpCSk7pnmGWW93P31fPmer9IowWmh2f55I5FguxX4czbxrvg==`). E2E Test Gate B formal public release (RELEASE_ATTESTED) remains a separate subsequent milestone.
- `artifact.e2e-test.browser.implement` and `artifact.e2e-test.browser.execute` are experimentally callable under explicit ExtensionBinding; default NOT_ENABLED.
- Does not replace `artifact-chain-assistant` generic `e2e`.

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** v0.2.1 is the current stable release. The specification
> kernel (help/default/author/review/repair) is stable with CANDIDATE_QUALIFIED
> qualification; Gate B RELEASE_ATTESTED remains a separate subsequent milestone.
> The browser extension (implement/execute) is experimental and defaults to
> NOT_ENABLED. Method-forward qualification remains FORWARD_TRIALS_PENDING_CODEX;
> release-artifact certification is `null`. The family defaults to NOT_ENABLED
> and fails closed without explicit project binding.

<!-- release-skill:capability:safe-first-command -->
> **Start here:** the safe read-only entry is the `e2e-test-help` diagnostic
> skill. It shows current Gate B status and capabilities without writing
> files or triggering external actions. Run `e2e-test-help` first to
> understand the current state after installation. The remaining services
> (`e2e-test-author`, `e2e-test-review`, `e2e-test-repair`) default to
> `NOT_ENABLED` and require explicit project binding before use.

## What Can It Do

| Skill | Input | Output |
|-------|-------|--------|
| **e2e-test-author** | Business requirements / PRD / scenario | E2E specification triple (artifact.e2e-test@1 artifact + eight-dimension matrix + artifact package manifest) |
| **e2e-test-review** | Existing E2E specification artifact | Structured review report (findings, severity, repairability) covering 12 rules |
| **e2e-test-repair** | Open findings from review report | Repaired specification preview + re-review result |
| **e2e-test-implement** (experimental) | Approved E2E specification | Playwright test code |
| **e2e-test-execute** (experimental) | Implemented Playwright tests | Canonical result from real Chromium execution plus structured evidence such as reporter/exit status, screenshot or trace references, network audit, resource facts, browser identity, and cleanup status |

### Specification Kernel vs. Browser Extension

The **specification kernel** (author / review / repair) operates entirely on E2E specification artifacts — it does not generate test code. It produces framework-neutral specifications with verification points, matrix coverage, and proof declarations.

The **browser extension** (implement / execute) bridges specifications to runnable Playwright tests. Under an explicit `ExtensionBinding`:
- `implement` generates Playwright test code from an approved specification
- `execute` runs those tests in a real Chromium browser and returns canonical results with structured evidence

Before execution, the runner re-verifies the frozen browser channel/version. The Docker isolation host blocks non-allowed egress at the operating-system boundary and applies cgroup/process-tree limits to time, memory, and child processes. A policy, resource, evidence, or cleanup failure fails closed and is never reported as a successful test run.

Both implement and execute are **experimental** and default to `NOT_ENABLED` — they require explicit `ExtensionBinding` configuration.

### Workflow Example

The following illustrates a complete flow from requirements to browser execution evidence. All invocations happen through the host's (Claude Code or Codex) skill mechanism — no standalone CLI commands are provided.

> **Scenario: E-commerce checkout flow**

```
User (in Claude Code):
  "Author an E2E test spec for the e-commerce checkout flow"

→ e2e-test-author produces a spec preview (zero writes):
  - artifact.e2e-test@1 artifact: acceptance criteria, verification points, proof declarations
  - Eight-dimension matrix: happy path, boundary, interruption recovery, etc.
  - User confirms → triple committed to the designated writeSet

User:
  "Review the spec I just authored"

→ e2e-test-review outputs a structured review report:
  - E2E-F-004 (happy-path only): severity=warning, repairable
  - E2E-F-009 (missing evidence): severity=error, repairable

User:
  "Repair these findings"

→ e2e-test-repair generates a repair preview (zero writes):
  - Adds boundary scenarios, completes proof declarations
  - User confirms → repaired artifact committed

User (requires ExtensionBinding to be configured):
  "Generate Playwright code from the approved spec and run it in the browser"

→ e2e-test-implement generates Playwright test code (preview → confirm → commit)
→ e2e-test-execute runs tests in real Chromium, returning:
  - canonical result (passed / failed / timed out)
  - Playwright reporter, exit status, screenshot or trace references
  - network audit, resource facts, browser version, and cleanup status
```

> **Note:** implement/execute are experimental and require explicit `ExtensionBinding` (default `NOT_ENABLED`). The other three services (author / review / repair) likewise require explicit project binding before use.

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
- Lifecycle: independent / stable (core); experimental (browser extension)

## License

Apache-2.0
