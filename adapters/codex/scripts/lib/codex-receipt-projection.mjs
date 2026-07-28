/**
 * 宿主输出投影与规范 receipt 二次校验辅助（Codex 面 A + Claude 面 A）。
 *
 * 规范 receipt Schema 的成功/失败互斥语义不得删除；两个宿主的结构化输出约束
 * 各自无法直接接受规范形状的某一部分，因此由 scripts 层从规范 Schema 确定性
 * 派生宿主投影，投影只放宽「宿主写出能力」，规范层 AJV 二次校验恢复全部严格语义。
 *
 * Codex：`--output-schema` 经 OpenAI Responses API 的 `text.format.schema` 校验，
 * 不接受顶层 `oneOf`（codex-cli 0.145.0-alpha.18 报错
 * "In context=(), 'oneOf' is not permitted."）。派生单对象投影：
 *
 * - 不携带 oneOf/anyOf/allOf/not/$ref（任何层级）；
 * - 每个对象层 additionalProperties: false 且所有字段 required（结构化输出约束）；
 * - 成功/失败两形态的互有字段 authorResult/failure 以 ["X","null"] 联合表达，
 *   两种诚实形态在投影层都能写出，但投影层不裁决互斥；
 * - 控制平面先经 normalizeHostReceipt 剥离 null 联合字段，再用规范 Schema 做
 *   AJV 二次校验，成功/失败互斥语义完全由规范层恢复。
 *
 * Claude：`--json-schema` 的宿主侧 AJV 约束完整接受顶层 oneOf，但规范失败分支
 * `failure: { type: "object" }` 会在宿主失败路径把 failure 序列化为 JSON 字符串时
 * 拒绝输出（`/failure: must be object` → error_max_structured_output_retries →
 * exit 1），控制平面拿不到结构化失败 receipt。派生投影保留顶层互斥 oneOf 与所有
 * 其它约束，仅把失败分支 failure 放宽为 `oneOf: [规范对象形状, string]`；控制平面
 * 经 normalizeHostReceipt 把字符串 failure 解析/规范化为对象后再做规范 AJV 二次
 * 校验，`failure 必须为对象`与成功/失败互斥语义完全由规范层恢复，投影层不裁决。
 */

export function buildCodexReceiptProjection(canonical) {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) throw coded('FORWARD_RECEIPT_CANONICAL_INVALID');
  const branches = Array.isArray(canonical.oneOf) ? canonical.oneOf : null;
  if (!branches || branches.length !== 2) throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  const success = branches.find(branch => branch?.properties?.status?.const === 'AUTHOR_PREVIEW_COMPLETE' && branch?.additionalProperties === false);
  const failure = branches.find(branch => Array.isArray(branch?.properties?.status?.enum) && branch?.additionalProperties === false);
  if (!success || !failure || success === failure) throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  const failureStatuses = failure.properties.status.enum;
  if (failureStatuses.some(status => !['AUTHOR_DRIVER_FAILED', 'BLOCKED', 'NEEDS_INPUT'].includes(status))) {
    throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  }
  const failureShape = failure.properties.failure;
  const diagnosticItems = failureShape?.properties?.diagnostics?.items;
  if (!failureShape || failureShape.additionalProperties !== false || !diagnosticItems) {
    throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  }
  return {
    $id: `${canonical.$id || 'e2e-test/method-forward-host-receipt/v1'}/codex-projection`,
    title: 'Method Forward Host Receipt (Codex output-schema projection)',
    description: 'Codex --output-schema 不接受顶层 oneOf。本投影把宿主输出放松为单对象形状；控制平面随后以规范 Schema 做 AJV 二次校验，成功/失败互斥语义在规范层恢复，投影层不裁决。',
    type: 'object',
    required: ['status', 'hostId', 'packageId', 'authorResult', 'failure'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: [success.properties.status.const, ...failureStatuses] },
      hostId: success.properties.hostId,
      packageId: success.properties.packageId,
      authorResult: { type: ['string', 'null'], enum: [success.properties.authorResult.const, null] },
      failure: {
        type: ['object', 'null'],
        // OpenAI 结构化输出要求对象所有字段 required；canonical failure 的可选
        // diagnostics 在投影层提升为必填（可为空数组），规范层仍允许缺省。
        required: ['code', 'diagnostics'],
        additionalProperties: false,
        properties: {
          code: failureShape.properties.code,
          diagnostics: {
            type: 'array',
            maxItems: failureShape.properties.diagnostics?.maxItems ?? 16,
            items: {
              type: 'object',
              required: ['code', 'stage', 'message'],
              additionalProperties: false,
              properties: {
                code: diagnosticItems.properties.code,
                stage: { type: ['string', 'null'], maxLength: diagnosticItems.properties.stage?.maxLength ?? 80 },
                message: { type: ['string', 'null'], maxLength: diagnosticItems.properties.message?.maxLength ?? 240 },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Claude `--json-schema` 宿主输出投影：从规范 Schema 确定性派生，保留顶层成功/
 * 失败互斥 oneOf 与成功分支逐字不变，仅把失败分支的 failure 放宽为
 * `oneOf: [规范 failure 对象形状, { type: "string" }]`。宿主失败时即使把 failure
 * 序列化为 JSON 字符串也能写出结构化输出，不再重试耗尽；控制平面随后经
 * normalizeHostReceipt 解析回对象并以规范 Schema 做 AJV 二次校验，规范层继续
 * 失败关闭（非法 JSON 字符串、混合成功/失败、残缺字段一律拒绝）。
 */
export function buildClaudeReceiptProjection(canonical) {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) throw coded('FORWARD_RECEIPT_CANONICAL_INVALID');
  const branches = Array.isArray(canonical.oneOf) ? canonical.oneOf : null;
  if (!branches || branches.length !== 2) throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  const success = branches.find(branch => branch?.properties?.status?.const === 'AUTHOR_PREVIEW_COMPLETE' && branch?.additionalProperties === false);
  const failure = branches.find(branch => Array.isArray(branch?.properties?.status?.enum) && branch?.additionalProperties === false);
  if (!success || !failure || success === failure) throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  const failureShape = failure.properties.failure;
  if (!failureShape || failureShape.type !== 'object' || failureShape.additionalProperties !== false) {
    throw coded('FORWARD_RECEIPT_CANONICAL_EXCLUSIVITY_MISSING');
  }
  const projection = JSON.parse(JSON.stringify(canonical));
  const failureBranch = projection.oneOf.find(branch => Array.isArray(branch?.properties?.status?.enum));
  failureBranch.properties.failure = {
    oneOf: [failureShape, { type: 'string', maxLength: 4096 }],
  };
  projection.$id = `${canonical.$id || 'e2e-test/method-forward-host-receipt/v1'}/claude-projection`;
  projection.title = 'Method Forward Host Receipt (Claude --json-schema projection)';
  projection.description = 'Claude --json-schema 宿主侧约束拒绝 failure 序列化为 JSON 字符串（must be object），失败 receipt 会退化为重试耗尽与 exit 1。本投影仅把失败分支 failure 放宽为 oneOf [object, string] 使宿主能写出结构化输出；顶层成功/失败互斥 oneOf 与其余约束逐字保留。控制平面规范化后以规范 Schema 做 AJV 二次校验，互斥与 failure 对象语义在规范层完全恢复，投影层不裁决。';
  return projection;
}

/**
 * 剥离投影层为兼容结构化输出而引入的 null 联合字段，使规范 Schema 的
 * additionalProperties: false 互斥两分支能够正确裁决。null 即缺席；
 * 非 null 的 failure/authorResult 原样保留，混合形态仍由规范层拒绝。
 *
 * 嵌套 null 同样剥离：投影层为满足 OpenAI 结构化输出「对象所有字段
 * required」把 failure.diagnostics[*].stage/message 提升为必填的
 * ["string","null"] 联合，真实 Codex 失败回执会在无诊断细节的条目中写出
 * stage: null / message: null；规范 Schema 中这两个字段是可选纯 string，
 * null 会使规范 AJV 二次校验失败。这里定向删除嵌套 null（null 即缺席），
 * 非对象条目与非 null 值原样保留，残缺/非法形态仍由规范层失败关闭。
 * 成功/失败互斥语义完全由规范层裁决，本函数不改写 status。
 */
export function normalizeHostReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
  const normalized = { ...receipt };
  if (normalized.failure === null) delete normalized.failure;
  if (normalized.authorResult === null) delete normalized.authorResult;
  // Claude Code --json-schema 结构化输出在某些失败路径下把 failure 序列化为
  // JSON 字符串而非对象。尝试解析回对象，使规范 Schema 的 type: "object" 校验
  // 能正确裁决；解析失败则原样保留，由规范层失败关闭。
  if (typeof normalized.failure === 'string') {
    try {
      const parsed = JSON.parse(normalized.failure);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) normalized.failure = parsed;
    } catch { /* 非法 JSON 字符串原样保留，规范层拒绝 */ }
  }
  if (normalized.failure && typeof normalized.failure === 'object' && !Array.isArray(normalized.failure)
    && Array.isArray(normalized.failure.diagnostics)) {
    normalized.failure = {
      ...normalized.failure,
      diagnostics: normalized.failure.diagnostics.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const normalizedItem = { ...item };
        if (normalizedItem.stage === null) delete normalizedItem.stage;
        if (normalizedItem.message === null) delete normalizedItem.message;
        return normalizedItem;
      }),
    };
  }
  return normalized;
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}
