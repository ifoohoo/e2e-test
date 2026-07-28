# Changelog

## 0.2.0-alpha.3 (2026-07-29) — 候选/准备中

### M2–M5 规格到浏览器实验性链路与 28 条失效模式覆盖守恒

- **M2–M5 规格链路**：从 E2E 规格编制（M2 extension design）经实现规划（M4 implementation planner）、代码草稿与审阅（M4 code draft/review），到浏览器执行（M5 browser execution）的实验性端到端链路已打通。
- **真实 Chrome canary 资格**：以真实 Chrome canary 环境完成三安装根（three installation roots）资格验证，覆盖 Chromium 目标浏览器的真实启动与执行路径。
- **28 条失效模式与覆盖守恒**：识别并记录 28 条失效模式（failure modes），覆盖守恒原则确保每条失效模式均有对应的守恒检查或已知残余风险标注。
- **implement/execute 仍为 planned**：`artifact.e2e-test.browser.implement` 和 `artifact.e2e-test.browser.execute` 仍为计划状态（planned），不可调用；不继承旧 26/26 行为资格。
- **启用前残余风险**：network、resource、system Chrome 相关风险为启用前残余风险，需在正式启用前完成缓解。
- **alpha.3 不等于 RELEASE_ATTESTED**：本版本为候选/准备中阶段，不具备 RELEASE_ATTESTED 资格；Gate B 最终接受和公共发布仍是后续独立事务。

### 已知限制

- 既有 26/26 操作行为资格使用确定性协议级 fake host；它不构成 M6 `implement/execute` 的真实宿主资格，也不覆盖真实 Chrome、网络或资源隔离风险。
- implement/execute 仍为 planned，不可调用。
- alpha.3 不等于 Gate B RELEASE_ATTESTED。

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
