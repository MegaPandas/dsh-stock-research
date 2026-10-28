import { describe, expect, it } from "vitest";
import type {
  ArtifactPayloads,
  DecisionProposal,
  DecisionResult,
  Rating,
} from "../../src/contracts/artifact-payloads.js";
import type { ArtifactKind } from "../../src/contracts/artifacts.js";
import { parseArtifactInput } from "../../src/services/artifact-schema.js";

const ref = { runId: "run", artifactId: "analysis", revision: 1 };
const source = {
  runId: "run",
  evidenceId: "prices",
  selector: "/data/bars/0/close",
};
const local = { kind: "local" as const, claimId: "base" };
const external = { kind: "artifact" as const, artifact: ref, claimId: "base" };
const statement = {
  text: "研究判断",
  evidence: [source],
  numbers: [local, external],
};
const issue = {
  issueId: "liquidity",
  description: "流动性风险",
  impact: "影响成交",
  trigger: "成交量下降",
  constraint: "限制仓位",
  recommendation: "观察成交",
  evidence: [source],
  numbers: [local],
};
function proposal(rating: Rating = "hold"): DecisionProposal {
  return {
    rating,
    horizonEndDate: "2025-06-30",
    thesis: [statement],
    basePrice: local,
    targetPrice: null,
    risks: ["流动性"],
    riskResponses: [
      { issueId: "liquidity", disposition: "accepted", reason: "已纳入判断" },
    ],
    invalidationConditions: ["经营假设改变"],
    limitations: ["资料有限"],
  };
}
function decision(): DecisionResult {
  return {
    ...proposal(),
    schemaVersion: 1,
    runId: "run",
    securityId: "US:EXAMPLE",
    cutoff: "2024-06-30T20:00:00.000Z",
    draftRef: ref,
    inputRefs: [ref],
    computedReturn: null,
    validation: { checkedRefs: [ref], warnings: [] },
    finalizedAt: "2024-07-01T00:00:00.000Z",
  };
}
function payloads(): ArtifactPayloads {
  return {
    analysis: {
      findings: [statement],
      risks: ["风险"],
      gaps: [{ code: "missing", field: "revenue", detail: "缺少披露" }],
    },
    debate: {
      side: "bull",
      arguments: [statement],
      rebuttals: [{ ...statement, target: ref }],
      unresolved: ["需求增速"],
    },
    risk: { issues: [issue] },
    plan: {
      thesis: [statement],
      questions: ["需求能否持续"],
      constraints: ["数据截止时间"],
    },
    digest: {
      facts: [statement],
      disagreements: ["需求增速"],
      risks: [issue],
      gaps: [],
      upstreamRefs: [ref],
      numbers: [],
    },
    decision_draft: proposal(),
    decision: decision(),
    report: {
      sections: [ref],
      digests: [ref],
      decision: decision(),
      limitations: ["资料有限"],
      gaps: [],
    },
  };
}
function artifact(
  kind: ArtifactKind = "analysis",
  payload: unknown = payloads()[kind],
) {
  return {
    kind,
    title: "研究",
    body: "# 判断\n\n依据 {{number:base}}。",
    inputRefs: [ref],
    claims: [
      { id: "base", kind: "observed", value: 100, unit: "USD/share", source },
    ],
    payload,
  };
}
function invalid(value: unknown, path: string) {
  expect(() => parseArtifactInput(value)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARTIFACT",
      message: expect.stringContaining(path),
    }),
  );
}

describe("parseArtifactInput payload boundary", () => {
  it.each([
    "analysis",
    "debate",
    "risk",
    "plan",
    "digest",
    "decision_draft",
    "decision",
    "report",
  ] as const)("accepts the closed %s payload", (kind) => {
    const input = artifact(kind);
    expect(parseArtifactInput(input)).toEqual(input);
  });
  it("rejects unknown container fields", () => {
    invalid({ ...artifact(), extra: true }, "artifact/extra");
  });
  it("requires container fields", () => {
    const input: Record<string, unknown> = artifact();
    delete input.body;
    invalid(input, "artifact/body");
  });
  it("rejects ratings embedded in analysis", () => {
    invalid(
      artifact("analysis", { ...payloads().analysis, rating: "buy" }),
      "artifact/payload/rating",
    );
  });
  it("requires the kind's payload fields", () => {
    invalid(
      artifact("analysis", { findings: [statement], risks: [] }),
      "artifact/payload/gaps",
    );
  });
  it("closes nested statement objects", () => {
    invalid(
      artifact("analysis", {
        ...payloads().analysis,
        findings: [{ ...statement, rating: "buy" }],
      }),
      "artifact/payload/findings/0/rating",
    );
  });
  it("accepts a fixed artifact as statement evidence without adding a source selector", () => {
    const input = artifact("analysis", {
      ...payloads().analysis,
      findings: [{ ...statement, evidence: [ref] }],
    });
    expect(parseArtifactInput(input).payload).toEqual(input.payload);
  });
  it("requires nested statement evidence", () => {
    invalid(
      artifact("analysis", {
        ...payloads().analysis,
        findings: [{ text: "判断", numbers: [] }],
      }),
      "artifact/payload/findings/0/evidence",
    );
  });
  it("requires report's embedded full decision result", () => {
    invalid(
      artifact("report", { ...payloads().report, decision: proposal() }),
      "artifact/payload/decision/schemaVersion",
    );
  });
  it.each([
    {
      kind: "source",
      source,
      gap: {
        code: "missing",
        field: "/data/items/0/location",
        detail: "No location",
      },
    },
    {
      kind: "artifact",
      artifact: ref,
      gap: {
        code: "missing",
        field: "coverage",
        detail: "Unresolved coverage",
      },
    },
  ])("keeps report gaps with $kind provenance", (gap) => {
    const input = artifact("report", { ...payloads().report, gaps: [gap] });
    expect(parseArtifactInput(input).payload).toEqual(input.payload);
  });
  it("requires nonempty main findings", () => {
    invalid(
      artifact("analysis", { ...payloads().analysis, findings: [] }),
      "artifact/payload/findings",
    );
  });
  it.each([
    "strong_buy",
    "buy",
    "hold",
    "sell",
    "strong_sell",
    "overweight",
    "neutral",
    "underweight",
  ] as const)("accepts %s with an explicitly absent target", (rating) => {
    expect(
      parseArtifactInput(artifact("decision_draft", proposal(rating))).payload,
    ).toEqual(proposal(rating));
  });
  it("rejects an unknown rating", () => {
    invalid(
      artifact("decision_draft", { ...proposal(), rating: "unrecognized" }),
      "artifact/payload/rating",
    );
  });
  it("accepts business thesis text with provenance kept at report level", () => {
    const value = artifact("decision_draft", {
      ...proposal(),
      thesis: [{ text: "研究判断", evidence: [], numbers: [] }],
    });
    expect(parseArtifactInput(value).payload).toEqual(value.payload);
  });
  it.each([
    {
      kind: "decision_draft" as const,
      payload: { ...proposal(), horizonEndDate: "2025-02-30" },
      path: "horizonEndDate",
    },
    {
      kind: "decision" as const,
      payload: { ...decision(), cutoff: "2024-06-30T20:00:00+08:00" },
      path: "cutoff",
    },
    {
      kind: "decision" as const,
      payload: { ...decision(), finalizedAt: "yesterday" },
      path: "finalizedAt",
    },
  ])(
    "reports invalid $path with its original cause",
    ({ kind, payload, path }) => {
      expect(() => parseArtifactInput(artifact(kind, payload))).toThrow(
        expect.objectContaining({
          code: "INVALID_ARTIFACT",
          message: expect.stringContaining(`/payload/${path}`),
          cause: expect.any(Error),
        }),
      );
    },
  );
  it.each([
    {
      kind: "risk" as const,
      payload: { issues: [issue, { ...issue }] },
      path: "/payload/issues",
    },
    {
      kind: "digest" as const,
      payload: { ...payloads().digest, risks: [issue, { ...issue }] },
      path: "/payload/risks",
    },
    {
      kind: "decision_draft" as const,
      payload: {
        ...proposal(),
        riskResponses: [
          proposal().riskResponses[0],
          proposal().riskResponses[0],
        ],
      },
      path: "/payload/riskResponses",
    },
  ])("rejects duplicate issueId in $kind", ({ kind, payload, path }) => {
    invalid(artifact(kind, payload), path);
  });
  it("accepts arbitrary long Markdown without a character limit", () => {
    const body =
      "# 研究 <tag>\n\n```text\n123 $ α 中文\n```\n" + "正文。".repeat(20_000);
    expect(parseArtifactInput({ ...artifact(), body }).body).toBe(body);
  });
});

describe("parseArtifactInput numeric structures", () => {
  const observed = {
    id: "base",
    kind: "observed",
    value: 100,
    unit: "USD/share",
    source,
  };
  const calculated = {
    id: "return",
    kind: "calculated",
    value: 0.2,
    unit: "ratio",
    operation: "simple_return",
    inputs: [local, external],
  };
  const estimated = {
    id: "target",
    kind: "estimated",
    value: 120,
    unit: "USD/share",
    method: "情景估计",
    assumptions: ["需求增长"],
    evidence: [source],
  };
  it.each([observed, calculated, estimated])(
    "accepts $kind claim structure",
    (claim) => {
      expect(
        parseArtifactInput({ ...artifact(), claims: [claim] }).claims,
      ).toEqual([claim]);
    },
  );
  it("requires observed source", () => {
    const claim: Record<string, unknown> = { ...observed };
    delete claim.source;
    invalid({ ...artifact(), claims: [claim] }, "/claims/0/source");
  });
  it("closes claim branches", () => {
    invalid(
      { ...artifact(), claims: [{ ...observed, method: "estimate" }] },
      "/claims/0/method",
    );
  });
  it("requires calculation inputs", () => {
    const claim: Record<string, unknown> = { ...calculated };
    delete claim.inputs;
    invalid({ ...artifact(), claims: [claim] }, "/claims/0/inputs");
  });
  it("requires estimate assumptions", () => {
    const claim: Record<string, unknown> = { ...estimated };
    delete claim.assumptions;
    invalid({ ...artifact(), claims: [claim] }, "/claims/0/assumptions");
  });
  it.each(["100", null, true, {}])(
    "rejects nonnumber claim value %j",
    (value) => {
      invalid(
        { ...artifact(), claims: [{ ...observed, value }] },
        "/claims/0/value",
      );
    },
  );
  it.each([
    { kind: "local", claimId: "base", artifact: ref },
    { kind: "artifact", claimId: "base" },
    { kind: "unknown", claimId: "base" },
  ])("enforces NumberInput branch fields for $kind", (basePrice) => {
    invalid(
      artifact("decision_draft", { ...proposal(), basePrice }),
      "/payload/basePrice",
    );
  });
  it("closes nested artifact references", () => {
    invalid(
      artifact("decision_draft", {
        ...proposal(),
        basePrice: { ...external, artifact: { ...ref, extra: true } },
      }),
      "/payload/basePrice/artifact/extra",
    );
  });
  it("reserves braces in claim identifiers for body references", () => {
    invalid(
      { ...artifact(), claims: [{ ...observed, id: "{base}" }] },
      "/claims/0/id",
    );
  });
});
