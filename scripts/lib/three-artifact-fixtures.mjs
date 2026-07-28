/**
 * 三件套（artifact / matrix / package manifest）fixture 工具。
 *
 * M1-A（§5.2 req 1/3）：review/repair 消费三件套输入并同步更新三件套输出。
 * 资格脚本（behavior-qualification-*）生成的语义 fixtures 必须以
 * "matrix 权威层变异 → 重投影 artifact → 重绑 manifest" 的单一事务派生，
 * 否则无法通过 verifyThreeArtifactConsistency 的 round-trip / 摘要 / 引用校验。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bindArtifactToMatrix, projectCaseToArtifact } from './matrix-dto.mjs';

const stem = output => output.replace(/\.json$/, '');

/** review/repair 请求的三件套输入引用（约定命名：<stem>.matrix.json / <stem>.package.json）。 */
export function threeArtifactRefs(artifactRel) {
  return {
    inputArtifact: artifactRel,
    inputMatrix: `${stem(artifactRel)}.matrix.json`,
    inputPackageManifest: `${stem(artifactRel)}.package.json`,
  };
}

/** repair 的三件套输出引用与 writeSet。 */
export function repairOutputSet(output) {
  const outputMatrix = `${stem(output)}.matrix.json`;
  const outputManifest = `${stem(output)}.package.json`;
  return { output, outputMatrix, outputManifest, writeSet: [output, outputMatrix, outputManifest] };
}

/** 读取 round-trip 一致的正例基底（artifact-roundtrip + matrix-roundtrip）。 */
export function loadRoundTripBase(pluginRoot) {
  const artifact = JSON.parse(readFileSync(join(pluginRoot, 'fixtures', 'positive', 'artifact-roundtrip.json'), 'utf8'));
  const matrix = JSON.parse(readFileSync(join(pluginRoot, 'fixtures', 'positive', 'matrix-roundtrip.json'), 'utf8'));
  return { artifact, matrix };
}

/**
 * 在 matrix 权威层施加变异后，重投影 artifact 使两者保持 round-trip 一致。
 * mutateMatrix(matrix, artifact) 只允许修改 matrix（权威层）。
 */
export function deriveConsistentSet(artifact, matrix, mutateMatrix = null) {
  if (mutateMatrix) mutateMatrix(matrix, artifact);
  const projectable = new Map((matrix.cases || []).map(item => [item.case_id, item]));
  artifact.test_cases = (artifact.test_cases || [])
    .filter(item => projectable.has(item.case_id))
    .map(item => projectCaseToArtifact(matrix, projectable.get(item.case_id)));
  return { artifact, matrix };
}

/** 绑定 manifest（引用指向落盘路径）并将三件套写入项目内。 */
export function writeThreeArtifactSet(projectRoot, artifactRel, { artifact, matrix }, bindContext = {}) {
  const refs = threeArtifactRefs(artifactRel);
  const manifest = bindArtifactToMatrix(artifact, matrix, {
    ...bindContext,
    artifactRef: refs.inputArtifact,
    matrixRef: refs.inputMatrix,
  });
  for (const [rel, value] of [
    [refs.inputArtifact, artifact],
    [refs.inputMatrix, matrix],
    [refs.inputPackageManifest, manifest],
  ]) {
    const abs = join(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { ...refs, artifact, matrix, manifest };
}
