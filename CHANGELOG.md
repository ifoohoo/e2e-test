# Changelog

## 0.1.0 (2026-07-18)

### Gate A: Independent Repository Skeleton

- Dual-repo structure: parent workspace + public plugin package.
- `e2e-test-help`: Read-only diagnostic skill with Gate A status, capability inventory, and next steps.
- `e2e-test`: Default entry point, returns `GATE_B_REQUIRED`.
- `e2e-test-author`: Fail-closed, returns `NOT_IMPLEMENTED`.
- `e2e-test-review`: Fail-closed, returns `NOT_IMPLEMENTED`.
- `e2e-test-repair`: Fail-closed, returns `NOT_IMPLEMENTED`.
- Draft implementation descriptor (`family/implementation.yaml`).
- Codex and Claude Code adapter skeletons.
- Deterministic build, check-skills, gate-status, and verify-public-release scripts.
- Public boundary verification and snapshot scripts.
- Test suite: plugin contract, skill family, adapter build, gate-a fail-closed, package content.

### Known Limitations

- No provider catalog emitted. Not entered into agent-method-registry effective index.
- Not enabled by default. Does not replace `artifact-chain-assistant` generic `e2e`.
- Author/review/repair are fail-closed contract placeholders. Not usable for real projects.
- Draft Artifact Contract and Family API — not registered with official authorities.
