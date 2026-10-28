import { describe, expect, it } from "vitest";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import { reportMaterial } from "../../src/report/material.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";

const base = {
  title: "阶段报告",
  body: "保存的正文。",
  inputRefs: [],
  claims: [],
};

describe("business report context", () => {
  it("carries public capture time with the canonical report without injecting storage metadata", () => {
    const report = agentAnalysisReport();
    const material = reportMaterial({
      ...base,
      kind: "analysis",
      payload: {
        schemaVersion: 3,
        report,
        publicSearchAsOf: "2026-10-27T13:24:52.770Z",
      },
    });
    expect(material).toEqual({
      title: "阶段报告",
      ...report,
      publicSearchAsOf: "2026-10-27T13:24:52.770Z",
    });
    expect(material).not.toHaveProperty("body");
  });

  it("keeps business risk identifiers and removes evidence and numeric plumbing", () => {
    const issue = {
      description: "渠道库存上升",
      impact: "现金占用增加",
      trigger: "库存增速超过交付",
      constraint: "限定库存情景下的估值假设",
      recommendation: "跟踪去库进度",
    };
    const artifact: ArtifactInput = {
      ...base,
      kind: "risk",
      payload: {
        report: {
          summary: "去库进度决定现金回流。",
          content: { issues: [issue] },
        },
        issues: [
          {
            ...issue,
            issueId: "risk.finance.1",
            evidence: [
              {
                runId: "internal-run",
                artifactId: "long-internal-id",
                revision: 1,
              },
            ],
            numbers: [],
          },
        ],
      },
    };
    expect(reportMaterial(artifact)).toEqual({
      title: "阶段报告",
      summary: "去库进度决定现金回流。",
      content: { issues: [{ ...issue, issueId: "risk.finance.1" }] },
    });
  });

  it("reads historical prose without fabricating a new business report", () => {
    expect(reportMaterial({ ...base, kind: "analysis", payload: {} })).toEqual({
      title: "阶段报告",
      body: "保存的正文。",
    });
  });
});
