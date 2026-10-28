import { expect, it } from "vitest";
import {
  assembleAgentArtifact,
  assembleBusinessReport,
} from "../../src/services/business-reports.js";
import type { AgentReport } from "../../src/contracts/agent-reports.js";

it("records decision inputs at report level and leaves thesis and estimate sources unassigned", () => {
  const ref = { runId: "run", artifactId: "digest", revision: 1 };
  const content = assembleBusinessReport(
    {
      rating: "hold",
      horizonEndDate: "2027-03-31",
      thesis: ["Demand and margins determine the outlook."],
      targetPrice: {
        value: 83.9,
        method: "Earnings times a valuation multiple",
        assumptions: ["Earnings of 30 billion CNY"],
      },
      risks: [],
      riskResponses: [],
      invalidationConditions: [],
      limitations: [],
    },
    {
      kind: "decision_draft",
      taskId: "manager.decision",
      specialty: "decision",
      title: "Decision",
      inputRefs: [ref],
      currency: "CNY",
      referencePrice: null,
    },
  );
  expect(content.inputRefs).toEqual([ref]);
  expect(content.payload).toMatchObject({
    thesis: [
      {
        text: "Demand and margins determine the outlook.",
        evidence: [],
        numbers: [],
      },
    ],
  });
  expect(content.claims).toEqual([
    {
      id: "decision.target",
      kind: "estimated",
      value: 83.9,
      unit: "CNY/share",
      method: "Earnings times a valuation multiple",
      assumptions: ["Earnings of 30 billion CNY"],
      evidence: [],
    },
  ]);
});

it("binds the rating and six-month horizon without changing the submitted business report", () => {
  const report: AgentReport<"decision_draft"> = {
    summary: "产品结构改善，现金回收决定估值。",
    content: {
      thesis: ["毛利率与存货周转决定利润和现金流。"],
      targetPrice: {
        value: 80,
        method: "预期利润乘估值倍数，再除总股数。",
        assumptions: ["利润310亿元，PE23.5倍，总股数91.17亿股。"],
      },
      risks: [],
      riskResponses: [],
      invalidationConditions: [],
      limitations: [],
    },
  };
  const original = structuredClone(report);
  const artifact = assembleAgentArtifact("decision_draft", report, {
    taskId: "manager.decision",
    specialty: "decision",
    title: "Manager decision",
    inputRefs: [],
    currency: "CNY",
    scope: {
      date: "2026-10-28",
      cutoff: "2026-10-27T16:21:19.148Z",
      security: {
        id: "CN:002594.SZ",
        market: "CN",
        symbol: "002594.SZ",
        exchange: "SZ",
        currency: "CNY",
        timeZone: "Asia/Shanghai",
      },
    },
    referencePrice: {
      artifact: { runId: "run", artifactId: "market", revision: 1 },
      claim: {
        id: "market.close",
        kind: "observed",
        value: 82.01,
        unit: "CNY/share",
        source: {
          runId: "run",
          evidenceId: "prices",
          selector: "/data/rows/0/values/close",
        },
      },
    },
  });
  expect(artifact.payload).toMatchObject({
    rating: "neutral",
    horizonEndDate: "2027-04-28",
    ratingPolicy: "absolute-price-6m/1",
    report: original,
  });
  expect(report).toEqual(original);
});
