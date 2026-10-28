import { expect, it } from "vitest";
import type { DigestModelInput } from "../../src/contracts/digests.js";
import { digestBusinessDraft } from "../../src/services/digest-business.js";
import { parseAgentReport } from "../../src/services/agent-reports.js";
import { US_SECURITY } from "../fixtures/market.js";

const ref = { runId: "run", artifactId: "analysis", revision: 1 };
const input: DigestModelInput = {
  scope: {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T22:00:00.000Z",
  },
  taskId: "digest",
  instructionVersion: 2,
  instruction: null,
  artifacts: [
    {
      ref,
      taskId: "analysis",
      attempt: 1,
      producerSessionId: null,
      createdAt: "2024-01-03T22:00:00.000Z",
      schemaVersion: 1,
      content: {
        kind: "analysis",
        title: "Analysis",
        body: "Revenue grew 20%.",
        inputRefs: [],
        claims: [],
        payload: {},
      },
    },
  ],
  reports: [],
  references: [ref],
  numbers: [],
  risks: [],
  gaps: [],
};
const report = {
  summary: "Revenue grew 20%.",
  content: {
    keyPoints: ["Growth reached 20%."],
    disagreements: [],
    riskSummaries: [{ issueId: "demand", text: "Demand may weaken." }],
    openQuestions: [],
  },
};

it("binds fixed inputs at report level without assigning them to individual facts", () => {
  expect(digestBusinessDraft(report, input)).toEqual({
    report,
    title: `${US_SECURITY.symbol} digest摘要`,
    body: report.summary,
    inputRefs: [ref],
    facts: [{ text: "Growth reached 20%.", inputRefs: [], numbers: [] }],
    disagreements: [],
    riskSummaries: report.content.riskSummaries,
  });
});

it.each([
  { ...report, inputRefs: [ref] },
  {
    ...report,
    content: {
      ...report.content,
      keyPoints: [{ text: "Growth", numbers: [] }],
    },
  },
  {
    ...report,
    content: {
      ...report.content,
      riskSummaries: [{ issueId: "demand", text: "Risk", evidence: [] }],
    },
  },
])("rejects internal metadata and nonbusiness fact shapes", (value) => {
  expect(() => parseAgentReport("digest", value)).toThrowError(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
});
