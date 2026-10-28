import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import { parseArtifactInput } from "../../src/services/artifact-schema.js";
import {
  checkNumbersParameters,
  saveReportParameters,
} from "../../src/tools/artifact-inputs.js";

const source = {
  runId: "run",
  evidenceId: "evidence",
  selector: "/data/bars/0/close",
};
const ref = { runId: "run", artifactId: "upstream", revision: 1 };
const number = { kind: "local" as const, claimId: "close" };
const statement = {
  text: "Fixed observation",
  evidence: [source],
  numbers: [number],
};
const base = {
  title: "Research",
  body: "Price {{number:close}}",
  inputRefs: [ref],
  claims: [
    {
      id: "close",
      kind: "observed" as const,
      value: 100,
      unit: "CNY/share",
      source,
    },
  ],
};
const contents: ResearchArtifactInput[] = [
  {
    ...base,
    kind: "analysis",
    payload: { findings: [statement], risks: [], gaps: [] },
  },
  {
    ...base,
    kind: "debate",
    payload: {
      side: "bull",
      arguments: [statement],
      rebuttals: [{ ...statement, target: ref }],
      unresolved: [],
    },
  },
  {
    ...base,
    kind: "risk",
    payload: {
      issues: [
        {
          issueId: "risk",
          description: "Source limitation",
          impact: "Unknown",
          trigger: "Changed source",
          constraint: "Use fixed data",
          recommendation: "Keep limitation",
          evidence: [source],
          numbers: [number],
        },
      ],
    },
  },
  {
    ...base,
    kind: "plan",
    payload: { thesis: [statement], questions: [], constraints: [] },
  },
  {
    ...base,
    kind: "decision_draft",
    payload: {
      rating: "hold",
      horizonEndDate: "2026-11-01",
      thesis: [statement],
      basePrice: number,
      targetPrice: null,
      risks: [],
      riskResponses: [
        { issueId: "risk", disposition: "accepted", reason: "Retained" },
      ],
      invalidationConditions: [],
      limitations: [],
    },
  },
];

describe("model-facing research artifact input contracts", () => {
  it.each(contents)(
    "accepts the domain $kind shape for submission and number checks",
    (content) => {
      expect(parseArtifactInput(content)).toEqual(content);
      const save = saveReportParameters();
      const check = checkNumbersParameters();
      assertSupportedJsonSchema(save);
      assertSupportedJsonSchema(check);
      expect(
        validateJsonSchemaValue(save, {
          requestId: "save",
          contents: [content],
        }),
      ).toEqual([]);
      expect(
        validateJsonSchemaValue(check, {
          kind: "pending",
          contentId: "pending",
          content,
        }),
      ).toEqual([]);
    },
  );

  it.each([
    { inputRefs: { item: source } },
    { claims: "" },
    { payload: { findings: { item: [statement] }, risks: [], gaps: [] } },
  ])(
    "rejects an observed array encoding failure before tool execution: %j",
    (changed) => {
      const content = { ...contents[0], ...changed };
      expect(
        validateJsonSchemaValue(saveReportParameters(["analysis"]), {
          requestId: "save",
          contents: [content],
        }).length,
      ).toBeGreaterThan(0);
      expect(
        validateJsonSchemaValue(checkNumbersParameters(["analysis"]), {
          kind: "pending",
          contentId: "pending",
          content,
        }).length,
      ).toBeGreaterThan(0);
    },
  );
});
