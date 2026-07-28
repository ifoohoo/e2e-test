# Semantic Negative Fixtures

这些负例必须先通过对应 schema/contract 验证，再由 review/reconcile runtime 产生稳定 `E2E-F-*` finding。

| 文件 | Schema | 预期 Finding |
|------|--------|-------------|
| matrix-happy-only.json | matrix.json ✓ | E2E-F-004: 只有 happy path，缺少 error/recovery 路径 |
| oracle-internal-dependency.json | matrix.json ✓ | E2E-F-005: oracle observable 面向内部实现（数据库查询），不可由用户/业务观察 |
| proof-runner-ignored.json | proof-binding.json ✓ | E2E-F-008: evidence status 为 skipped；E2E-F-012: freshness 为 stale |
