# Changelog

## 0.2.1 (2026-08-02) — stable

### Git marketplace 运行时依赖闭包

- **自包含运行时 bundle**：公开根、Claude adapter 与 Codex adapter 均携带 Ajv、ajv-formats 和 TypeScript 所需的确定性 bundle，不再依赖安装目录外的 `node_modules`。
- **真实安装回归**：新增 Git marketplace 闭包测试，在无依赖目录的公开快照中执行 help 与服务入口，防止再次出现 `ERR_MODULE_NOT_FOUND`。
- **生成与许可证闭包**：加入可复现的 runtime bundle 生成器、第三方许可证清单和发布面文件约束；生成结果不受本地绝对路径影响。
- **诚实失败语义**：仅在自包含 runtime bundle 不可用时返回结构化失败，不把缺失依赖误报为业务成功。

### 已知限制

- implement/execute 为 experimental，默认 NOT_ENABLED，需要显式 ExtensionBinding。
- 方法前向资格仍为 FORWARD_TRIALS_PENDING_CODEX（真实双宿主试验尚未完成）。
- 发布制品认证（releaseArtifactCertification）为 null。

## 0.2.0 (2026-08-02) — stable

### 正式版：核心 stable、R39 产品修复、浏览器扩展 experimental

- **核心生命周期升级**：help/default/author/review/repair 五个服务从 experimental 升级为 stable，具备 CANDIDATE_QUALIFIED 资格。
- **版本归一化**：从 `0.2.0-alpha.4` prerelease 归一化为 `0.2.0` 正式版。
- **R39 敏感边界修复**：`deriveTrustBoundaries` 从 inspection 约束中识别敏感/隐私/凭据/信任边界关键词，写入标准制品 `trust_boundaries`；普通时延和异步约束不会误入。
- **R39 负向不变量修复**：`projectOracle` 将矩阵 `negative_check` 合并到 oracle criterion，确保负向不变量进入对应验收标准。
- **浏览器扩展保持 experimental**：`artifact.e2e-test.browser.implement` 和 `artifact.e2e-test.browser.execute` 仍为实验性，需要显式 ExtensionBinding，默认 NOT_ENABLED。
- **Registry 前置**：`agent-method-registry@0.2.2` 已正式发布并验证。
- **统一 marketplace**：Claude Code 与 Codex 统一 marketplace 已在 alpha.4 验证可用。

### 已知限制

- implement/execute 为 experimental，默认 NOT_ENABLED，需要显式 ExtensionBinding。
- 方法前向资格仍为 FORWARD_TRIALS_PENDING_CODEX（真实双宿主试验尚未完成）。
- 发布制品认证（releaseArtifactCertification）为 null。

## 0.2.0-alpha.4 (2026-08-01) — GitHub prerelease

### 浏览器公开 implement→execute、真实 Chromium、三根证明闭包

- **浏览器公开链路**：`artifact.e2e-test.browser.implement` 和 `artifact.e2e-test.browser.execute` 在显式 ExtensionBinding 下实验性可调用；默认 NOT_ENABLED。
- **真实 Chromium**：以真实 Chromium 环境完成浏览器执行路径验证。
- **网络/资源/浏览器策略**：网络、资源隔离和浏览器策略已集成到执行路径。
- **ExtensionBinding 生命周期**：项目 binding 持续有效至显式撤销，或 package/contract/service/scope/write-set/permission/digest 漂移；`boundAt` 只作审计时间，不引入隐式 TTL。
- **OneTimeHandle**：副作用时效和防重放由一次性 handle 的 expiry 与消费状态机承担。
- **三根操作证明身份闭包**：root、Codex adapter 与 Claude adapter 的 descriptor、conformance 和 behavior qualification 身份可独立复算；`releaseArtifactCertification` 仍为 `null`。
- **service-runner 版本动态化**：消除 service-runner.mjs 对版本的硬编码，从 implementation descriptor 动态获取期望版本。
- **alpha.4 不等于 RELEASE_ATTESTED**：本版本作为 GitHub prerelease（PUBLIC_RELEASE_READY）发布；不具备 RELEASE_ATTESTED 资格。统一 marketplace 可用性由独立事务治理。

### 已知限制

- alpha.4 是 GitHub prerelease，不具备 RELEASE_ATTESTED。
- implement/execute 默认 NOT_ENABLED，需要显式 ExtensionBinding。
- 方法前向资格仍为 FORWARD_TRIALS_PENDING_CODEX。

## 0.2.0-alpha.3 (2026-07-29) — 已发布

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
