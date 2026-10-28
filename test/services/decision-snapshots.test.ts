import { afterEach, describe, expect, it } from "vitest";
import type { ReportPayload } from "../../src/contracts/artifact-payloads.js";
import type { MarketData } from "../../src/contracts/data.js";
import type { EvidenceInput } from "../../src/contracts/task-data.js";
import { DecisionService } from "../../src/services/decisions.js";
import { decisionFixture } from "../fixtures/decision.js";

const gap = {
  code: "unverified_time",
  field: "/data/bars",
  detail:
    "The source does not establish publication time or historical versions.",
} as const;
function captured(frame: EvidenceInput<MarketData>) {
  frame.envelope.retrievedAt = "2024-01-03T21:30:00.000Z";
  frame.envelope.availableAt = null;
  frame.envelope.historicalKnowledge = "unverified";
  for (const bar of frame.envelope.data.bars) bar.availableAt = null;
  frame.envelope.gaps.push({ ...gap });
}
const fixtures: ReturnType<typeof decisionFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe("decision use of captured snapshots", () => {
  it("completes with early captured values and preserves the original source gap", () => {
    const c = decisionFixture({ frame: captured });
    fixtures.push(c);
    const evidence = c.runs.readEvidence(c.source);
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "decide",
    );
    expect(c.runs.view(c.operation).status).toBe("completed");
    const report = c.runs.readArtifact(result.refs[1]!).content
      .payload as ReportPayload;
    expect(report.gaps).toContainEqual({
      kind: "source",
      source: {
        runId: c.source.runId,
        evidenceId: c.source.evidenceId,
        selector: "",
      },
      gap,
    });
    expect(c.runs.readEvidence(c.source)).toEqual(evidence);
    expect(evidence.envelope).toMatchObject({
      retrievedAt: "2024-01-03T21:30:00.000Z",
      availableAt: null,
      historicalKnowledge: "unverified",
    });
  });

  it("publishes a stale captured observation with its warning", () => {
    const c = decisionFixture({
      frame: (frame) => {
        captured(frame);
        frame.envelope.stale = true;
        frame.envelope.gaps.push({
          code: "stale",
          field: "/asOf",
          detail: "The captured observation exceeds its freshness policy.",
        });
      },
    });
    fixtures.push(c);
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "decide",
    );
    const report = c.runs.readArtifact(result.refs[1]!).content
      .payload as ReportPayload;
    expect(report.decision.validation.warnings).toContainEqual(
      expect.stringContaining("freshness policy"),
    );
    expect(c.runs.view(c.operation).status).toBe("completed");
  });

  it("rejects an unverified value captured after the historical cutoff", () => {
    expect(() =>
      decisionFixture({
        frame: (frame) => {
          captured(frame);
          frame.envelope.retrievedAt = "2024-01-04T00:00:00.000Z";
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "NUMBER_MISMATCH",
        checks: expect.arrayContaining([
          expect.objectContaining({
            passed: false,
            claims: expect.arrayContaining([
              expect.objectContaining({
                issues: expect.arrayContaining([
                  expect.objectContaining({ code: "time" }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });
});
