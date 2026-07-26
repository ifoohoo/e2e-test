# Changelog

## 0.2.0-alpha.2 (2026-07-27)

### 状态收敛与安装合同修复

- **状态事实统一**：修正所有"尚未发布"陈述，明确区分 alpha 预发布与 Gate B 正式公共发布。
- **平台能力矩阵**：按 Claude Code、Codex、CodeBuddy、Kimi 四个平台记录身份、adapter、市场列名、安装验证和行为资格。
- **Registry v2 证据**：记录 v1 兼容与 v2 采用的可复算证据，fail-closed 策略明确。
- **外部市场候选提案**：记录 release-skill 0.2.2 外部独立市场形态首例经验。
- **安装合同修复**：统一市场为实际安装入口，移除 npm E404 误导命令。
- **门禁增强**：根 .claude-plugin/plugin.json 加入 requiredPaths 和契约测试。
- **已知限制**：Codex 真宿主 BLOCKED（额度未恢复），CodeBuddy NOT_VERIFIED，Kimi NOT_VERIFIED。CANDIDATE_QUALIFIED 保持不变，未提升为 RELEASE_ATTESTED。

## 0.2.0-alpha.1 (2026-07-19)

### Gate B Candidate: Registry 0.2.0 Method Query Adoption & Behavior Qualification

- **Registry 0.2.0 Integration**: `agent-method-registry@0.2.0` installed as dependency; service-runner uses `buildEffectiveIndex` → `queryEffectiveIndex(purpose: 'prepare')` → `resolveEntry(preparedQueryHandle)` → `verifyProvider(runLock)` full v2 chain.
- **Implementation Descriptor**: v2 format with real bundle tree digest verified against Registry's `computeBundleTreeDigest` algorithm.
- **Five Services**: default/help/author/review/repair — preflight verified with real run lock and filesystem reverify.
- **Behavior Qualification**: Dual-host (Codex + Claude) Gate B passed with 13 scenarios × 2 hosts = 26 trials per run, two consecutive runs stable.
- **Self-Contained**: All source-code bypass paths removed; Registry access exclusively via `import('agent-method-registry')` package.
- **Cross-Repo Candidate Verification**: `scripts/verify-cross-repo-candidates.mjs` validates tarball isolation, Registry version, three canonical roots, fail-closed behavior, and path leak absence across two consecutive runs.
- **Deterministic Scripts**: conformance-runner, bundle-digest, gate-status updated to use installed package.
- **Host Support**: Codex and Claude declared in implementation descriptor.
- **Default NOT_ENABLED**: Provider does not auto-enable; requires explicit project binding.
- **Known Limitations**: Registry 0.2 and E2E Test are not yet published; no detached release attestation; CANDIDATE_QUALIFIED only (not RELEASE_ATTESTED).

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
