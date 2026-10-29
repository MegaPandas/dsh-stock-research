import { describe, expect, it } from "vitest";
import type {
  DigestDraft,
  DigestModelInput,
} from "../../src/contracts/digests.js";
import { assembleDigest } from "../../src/services/digest-draft.js";
import { US_SECURITY } from "../fixtures/market.js";

describe("digest identity diagnostics", () => {
  it("identifies the required direct inputs while allowing facts to cite inherited references", () => {
    const direct = { runId: "run", artifactId: "direct", revision: 1 };
    const inherited = { runId: "run", artifactId: "inherited", revision: 1 };
    const context: DigestModelInput = {
      scope: {
        security: US_SECURITY,
        date: "2024-01-08",
        cutoff: "2024-01-08T22:00:00.000Z",
      },
      taskId: "digest.debate",
      instructionVersion: 2,
      instruction: null,
      reports: [],
      artifacts: [
        {
          ref: direct,
          taskId: "debate",
          attempt: 1,
          producerSessionId: null,
          createdAt: "2024-01-08T22:00:00.000Z",
          schemaVersion: 1,
          content: {
            kind: "debate",
            title: "Direct input",
            body: "Inherited qualitative finding.",
            inputRefs: [inherited],
            claims: [],
            payload: {},
          },
        },
      ],
      references: [direct, inherited],
      numbers: [],
      risks: [],
      gaps: [],
    };
    const reply: DigestDraft = {
      title: "Summary",
      body: "Fixed qualitative summary.",
      inputRefs: [direct, inherited],
      facts: [
        { text: "Inherited finding", inputRefs: [inherited], numbers: [] },
      ],
      disagreements: [],
      riskSummaries: [],
    };
    expect(() => assembleDigest(reply, context)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: expect.stringContaining(
          'Expected [{"runId":"run","artifactId":"direct","revision":1}]; received [{"runId":"run","artifactId":"direct","revision":1},{"runId":"run","artifactId":"inherited","revision":1}]',
        ),
      }),
    );
    expect(
      assembleDigest({ ...reply, inputRefs: [direct] }, context),
    ).toMatchObject({
      inputRefs: [direct, inherited],
      payload: { facts: [{ evidence: [inherited] }] },
    });
  });

  it("preserves full risks in metadata and renders only their summaries", () => {
    const risk = {
      issueId: "liquidity",
      description: "Original full risk description",
      impact: "Original full impact",
      trigger: "Original full trigger",
      constraint: "Original full constraint",
      recommendation: "Original full recommendation",
      evidence: [],
      numbers: [],
    };
    const context: DigestModelInput = {
      scope: {
        security: US_SECURITY,
        date: "2024-01-08",
        cutoff: "2024-01-08T22:00:00.000Z",
      },
      taskId: "digest.risk",
      instructionVersion: 3,
      instruction: null,
      reports: [],
      artifacts: [],
      references: [],
      numbers: [],
      risks: [risk],
      gaps: [],
    };
    const content = assembleDigest(
      {
        title: "Summary",
        body: "Decision variables",
        inputRefs: [],
        facts: [],
        disagreements: [],
        riskSummaries: [
          {
            issueId: "liquidity",
            text: "Watch liquidity before increasing exposure.",
          },
        ],
      },
      context,
    );
    expect(content.payload.risks).toEqual([risk]);
    expect(content.body).toContain(
      "liquidity：Watch liquidity before increasing exposure.",
    );
    expect(content.body).not.toContain("Original full");
    expect(content.body).not.toContain("## 继承风险");
  });

  it("retains an explicit empty risk set instead of accepting invented risk IDs", () => {
    const context: DigestModelInput = {
      scope: {
        security: US_SECURITY,
        date: "2024-01-08",
        cutoff: "2024-01-08T22:00:00.000Z",
      },
      taskId: "digest.analysis",
      instructionVersion: 2,
      instruction: null,
      reports: [],
      artifacts: [],
      references: [],
      numbers: [],
      risks: [],
      gaps: [],
    };
    const reply: DigestDraft = {
      title: "Summary",
      body: "Fixed qualitative summary",
      inputRefs: [],
      facts: [],
      disagreements: [],
      riskSummaries: [{ issueId: "invented", text: "An unprovided risk" }],
    };
    expect(() => assembleDigest(reply, context)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: expect.stringContaining('Expected []; received ["invented"]'),
      }),
    );
  });

  it("renders the canonical business report once and retains the original risk metadata", () => {
    const risk = {
      issueId: "cash",
      description: "Full loss mechanism",
      impact: "Full impact",
      trigger: "Full trigger",
      constraint: "Full constraint",
      recommendation: "Full recommendation",
      evidence: [],
      numbers: [],
    };
    const context: DigestModelInput = {
      scope: {
        security: US_SECURITY,
        date: "2024-01-08",
        cutoff: "2024-01-08T22:00:00.000Z",
      },
      taskId: "digest.risk",
      instructionVersion: 1,
      instruction: null,
      artifacts: [],
      reports: [],
      references: [],
      numbers: [],
      risks: [risk],
      gaps: [],
    };
    const report = {
      summary: "Cash conversion determines the next stage.",
      content: {
        keyPoints: ["Receivables grew faster than sales."],
        disagreements: [],
        riskSummaries: [
          { issueId: "cash", text: "Receivable collection constrains cash." },
        ],
        openQuestions: ["Does collection improve next quarter?"],
      },
    };
    const artifact = assembleDigest(
      {
        report,
        title: "Risk digest",
        body: report.summary,
        inputRefs: [],
        facts: [
          { text: report.content.keyPoints[0]!, inputRefs: [], numbers: [] },
        ],
        disagreements: [],
        riskSummaries: report.content.riskSummaries,
      },
      context,
    );
    expect(artifact.payload.report).toEqual(report);
    expect(artifact.payload.risks).toEqual([risk]);
    expect(artifact.payload.facts).toEqual([
      { text: report.content.keyPoints[0], evidence: [], numbers: [] },
    ]);
    expect(
      artifact.body.match(/Cash conversion determines the next stage\./g),
    ).toHaveLength(1);
    expect(
      artifact.body.match(/Receivables grew faster than sales\./g),
    ).toHaveLength(1);
    expect(artifact.body).toContain(report.content.openQuestions[0]);
    expect(artifact.body).not.toContain("Full loss mechanism");
    expect(artifact.body).not.toContain("## 未决分歧");
  });
});
