import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { ArtifactKind } from "../contracts/artifacts.js";
import {
  artifactRefSchema,
  objectSchema,
  sourceRefSchema,
  stringSchema,
} from "./parameters.js";

type RoleArtifactKind = Exclude<ArtifactKind, "digest" | "decision" | "report">;
const KINDS: readonly RoleArtifactKind[] = [
  "analysis",
  "debate",
  "risk",
  "plan",
  "decision_draft",
];
const list = (items: JsonSchemaNode): JsonSchemaNode => ({
  type: "array",
  items,
});
const strings = list(stringSchema);
const enumeration = (...values: string[]): JsonSchemaNode => ({
  type: "string",
  enum: values,
});
const literal = (value: string): JsonSchemaNode => ({
  type: "string",
  const: value,
});
const numberInput: JsonSchemaNode = {
  oneOf: [
    objectSchema({ kind: literal("local"), claimId: stringSchema }),
    objectSchema({
      kind: literal("artifact"),
      artifact: artifactRefSchema,
      claimId: stringSchema,
    }),
  ],
};
const support = {
  text: stringSchema,
  evidence: list({ oneOf: [sourceRefSchema, artifactRefSchema] }),
  numbers: list(numberInput),
};
const statement = objectSchema(support);
const gap = objectSchema({
  code: enumeration("missing", "stale", "unverified_time", "incomparable"),
  field: stringSchema,
  detail: stringSchema,
});
const claimBase = {
  id: stringSchema,
  value: { type: "number" } as const,
  unit: stringSchema,
};
const claims = list({
  oneOf: [
    objectSchema({
      ...claimBase,
      kind: literal("observed"),
      source: sourceRefSchema,
    }),
    objectSchema({
      ...claimBase,
      kind: literal("calculated"),
      operation: literal("simple_return"),
      inputs: list(numberInput),
    }),
    objectSchema({
      ...claimBase,
      kind: literal("estimated"),
      method: stringSchema,
      assumptions: strings,
      evidence: list(sourceRefSchema),
    }),
  ],
});
const payloads: Record<RoleArtifactKind, JsonSchemaNode> = {
  analysis: objectSchema({
    findings: list(statement),
    risks: strings,
    gaps: list(gap),
  }),
  debate: objectSchema({
    side: enumeration("bull", "bear"),
    arguments: list(statement),
    rebuttals: list(objectSchema({ ...support, target: artifactRefSchema })),
    unresolved: strings,
  }),
  risk: objectSchema({
    issues: list(
      objectSchema({
        issueId: stringSchema,
        description: stringSchema,
        impact: stringSchema,
        trigger: stringSchema,
        constraint: stringSchema,
        recommendation: stringSchema,
        evidence: support.evidence,
        numbers: support.numbers,
      }),
    ),
  }),
  plan: objectSchema({
    thesis: list(statement),
    questions: strings,
    constraints: strings,
  }),
  decision_draft: objectSchema({
    rating: {
      oneOf: [
        enumeration(
          "strong_buy",
          "buy",
          "hold",
          "sell",
          "strong_sell",
          "overweight",
          "neutral",
          "underweight",
        ),
        { type: "null" },
      ],
    },
    horizonEndDate: stringSchema,
    thesis: list(statement),
    basePrice: { oneOf: [numberInput, { type: "null" }] },
    targetPrice: { oneOf: [numberInput, { type: "null" }] },
    risks: strings,
    riskResponses: list(
      objectSchema({
        issueId: stringSchema,
        disposition: enumeration(
          "accepted",
          "mitigated",
          "constrained",
          "unresolved",
        ),
        reason: stringSchema,
      }),
    ),
    invalidationConditions: strings,
    limitations: strings,
  }),
};

function artifactSchema(kinds: readonly RoleArtifactKind[]): JsonSchemaNode {
  const branches = kinds.map((kind) =>
    objectSchema({
      kind: literal(kind),
      title: stringSchema,
      body: stringSchema,
      inputRefs: {
        ...list(artifactRefSchema),
        description:
          "仅已采用的固定产物版本；来源引用放在payload.evidence或claims.source，无上游产物用[]。",
      },
      claims,
      payload: payloads[kind],
    }),
  );
  return branches.length === 1 ? branches[0]! : { oneOf: branches };
}

/** Model-visible structure matches the domain parser; semantic checks remain in services. */
export function saveReportParameters(
  kinds: readonly RoleArtifactKind[] = KINDS,
): JsonSchemaNode & Record<string, unknown> {
  return objectSchema({
    requestId: stringSchema,
    contents: list(artifactSchema(kinds)),
  });
}

export function checkNumbersParameters(
  kinds: readonly RoleArtifactKind[] = KINDS,
): JsonSchemaNode & Record<string, unknown> {
  return {
    oneOf: [
      objectSchema({ kind: literal("artifact"), ref: artifactRefSchema }),
      objectSchema({
        kind: literal("pending"),
        contentId: stringSchema,
        content: artifactSchema(kinds),
      }),
    ],
  };
}
