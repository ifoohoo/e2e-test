---
name: e2e-test-stage-compose
description: 仅供 E2E author 内部编排确定性投影八维矩阵并生成最小 E2E 制品包；不是用户入口。
---

# Compose 内部工序

本工序不做模型创作。运行时使用 `composeArtifact` 逐 case 投影为 `artifact.e2e-test@1`，并生成矩阵伴生文件和内容寻址的 package manifest。

禁止用 `cases[0]` 代表其他 case，禁止向通用 Artifact Contract 塞入 family 私有八维字段，也禁止遗漏 artifact、matrix、manifest 三件套中的任一项。

调用 `workers/compose-worker.mjs`，不得携带 `stageOutput`，不得直接写项目。
