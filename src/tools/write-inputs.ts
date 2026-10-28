import type { DataGap, EvidenceRef, ResearchScope } from "../contracts/data.js";
import type { RememberInput } from "../contracts/memory-service.js";
import type { MemoryRef } from "../contracts/memory.js";
import {
  artifactRef,
  artifactRefSchema,
  invalid,
  object,
  objectSchema,
  positive,
  sourceRef,
  sourceRefSchema,
  stringSchema,
  text,
} from "./parameters.js";
import {
  dataSchemas,
  parseDataRequest,
  type QueryToolPolicy,
} from "./query-inputs.js";

const gapCodes = [
  "missing",
  "stale",
  "unverified_time",
  "incomparable",
] as const;
export const memoryRefSchema = objectSchema({
  entryId: stringSchema,
  revision: { type: "integer", description: "正安全整数修订号。" },
});
export const rememberInputSchema = objectSchema({
  previous: { oneOf: [memoryRefSchema, { type: "null" }] },
  outcome: stringSchema,
  note: stringSchema,
  evidence: {
    type: "array",
    items: { oneOf: [artifactRefSchema, sourceRefSchema] },
  },
  returns: {
    oneOf: [
      objectSchema({
        kind: { type: "string", const: "query" },
        request: dataSchemas.stock_get_returns,
      }),
      objectSchema({
        kind: { type: "string", const: "unavailable" },
        gaps: {
          type: "array",
          items: objectSchema({
            code: { type: "string", enum: [...gapCodes] },
            field: stringSchema,
            detail: stringSchema,
          }),
        },
      }),
    ],
  },
});
function memoryRef(value: unknown): MemoryRef {
  const item = object(value, ["entryId", "revision"]);
  return {
    entryId: text(item.entryId, "entryId"),
    revision: positive(item.revision, "revision"),
  };
}
export function rememberInput(
  value: unknown,
  scope: ResearchScope,
  policy: QueryToolPolicy,
): RememberInput {
  const item = object(value, [
    "previous",
    "outcome",
    "note",
    "evidence",
    "returns",
  ]);
  if (!Array.isArray(item.evidence))
    invalid("evidence requires fixed references.");
  const evidence: EvidenceRef[] = item.evidence.map((value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "artifactId")
      ? artifactRef(value)
      : sourceRef(value),
  );
  const kind = (item.returns as { kind?: unknown } | null)?.kind;
  const returns = object(
    item.returns,
    kind === "query" ? ["kind", "request"] : ["kind", "gaps"],
  );
  let result: RememberInput["returns"];
  if (kind === "query") {
    const parsed = parseDataRequest(
      "stock_get_returns",
      returns.request,
      scope,
      policy,
    );
    if (parsed.source !== null)
      invalid("A review memory cannot select a task replay source.");
    result = { kind: "query", request: parsed.request };
  } else {
    if (kind !== "unavailable") invalid("Unknown memory returns kind.");
    if (!Array.isArray(returns.gaps) || returns.gaps.length === 0)
      invalid("Unavailable returns require a nonempty gap explanation.");
    const gaps = returns.gaps.map((value: unknown): DataGap => {
      const gap = object(value, ["code", "field", "detail"]);
      if (!gapCodes.includes(gap.code as DataGap["code"]))
        invalid("Unknown data gap code.");
      return {
        code: gap.code as DataGap["code"],
        field: text(gap.field, "field"),
        detail: text(gap.detail, "detail"),
      };
    });
    result = { kind: "unavailable", gaps: gaps as [DataGap, ...DataGap[]] };
  }
  return {
    previous: item.previous === null ? null : memoryRef(item.previous),
    outcome: text(item.outcome, "outcome"),
    note: text(item.note, "note"),
    evidence,
    returns: result,
  };
}
