import { expect, it } from "vitest";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import {
  parseAgentReport,
  validateStoredAgentReport,
} from "../../src/services/agent-reports.js";
import { validateRoleValuation } from "../../src/services/valuation.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import { US_SECURITY } from "../fixtures/market.js";
import { valuationRecord } from "../fixtures/valuation.js";

const scope = {
  security: US_SECURITY,
  date: "2024-01-03",
  cutoff: "2024-01-03T22:00:00.000Z",
};
const methodIds = ["comparable_multiples"];
function decision(quantified = true): AgentReport<"decision_draft"> {
  return {
    summary: "人工估值场景。",
    content: {
      thesis: ["人工盈利假设用于测试。"],
      targetPrice: quantified
        ? {
            value: 230.4,
            method: "盈利倍数情景",
            assumptions: ["EPS为8，PE为28.8倍。"],
          }
        : null,
      valuation: valuationRecord(scope.date, "USD", quantified),
      risks: [],
      riskResponses: [],
      invalidationConditions: [],
      limitations: [],
    },
  };
}

it("retains structured assumptions and explicit missing ranges without changing old stored reports", () => {
  const old = agentAnalysisReport();
  expect(() => validateStoredAgentReport("analysis", old)).not.toThrow();
  const report = {
    ...old,
    content: { ...old.content, valuation: valuationRecord(scope.date, "USD") },
  };
  expect(parseAgentReport("analysis", report)).toEqual(report);
  expect(() =>
    validateRoleValuation(report, "analysis.fundamentals", scope, methodIds),
  ).not.toThrow();
  expect(() =>
    validateRoleValuation(
      decision(false),
      "manager.decision",
      scope,
      methodIds,
    ),
  ).not.toThrow();
  expect(() =>
    validateRoleValuation(old, "analysis.fundamentals", scope, methodIds),
  ).toThrow(/valuation section/);
});

it.each([
  "empty-methods",
  "unordered-range",
  "missing-provenance",
  "missing-calculation",
  "unexplained-null",
])("rejects %s at report submission", (problem) => {
  const report = decision();
  const record = report.content.valuation!;
  const method = record.methods[0]!;
  if (problem === "empty-methods") record.methods = [];
  else if (problem === "unordered-range") method.valueRange!.low = 241;
  else if (problem === "missing-provenance") method.inputs[0]!.basis = " ";
  else if (problem === "missing-calculation") method.calculation = [];
  else {
    method.valueRange = null;
    method.limitations = [];
  }
  expect(() => parseAgentReport("decision_draft", report)).toThrowError(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
});

it.each([
  "unknown-method",
  "wrong-date",
  "wrong-target-date",
  "wrong-unit",
  "missing-price-basis",
  "unsupported-target",
])("rejects %s against the recorded run policy", (problem) => {
  const report = decision();
  const record = report.content.valuation!;
  if (problem === "unknown-method")
    record.methods[0]!.methodId = "invented-model";
  else if (problem === "wrong-date") record.valuationDate = "2024-01-02";
  else if (problem === "wrong-target-date") record.targetDate = "2024-07-04";
  else if (problem === "wrong-unit")
    record.methods[0]!.valueRange!.unit = "CNY/share";
  else if (problem === "missing-price-basis") record.targetPriceBasis = null;
  else record.methods[0]!.valueRange = null;
  expect(() =>
    validateRoleValuation(report, "manager.decision", scope, methodIds),
  ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});
