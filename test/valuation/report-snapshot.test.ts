import { expect, it } from "vitest";
import { valuationCalculationSnapshotSchema } from "../../src/contracts/agent-reports.js";
import type { ValuationCalculation } from "../../src/contracts/valuation.js";
import { assertJsonSchema } from "../../src/json/schema.js";
import { valuationCalculationSnapshot } from "../../src/valuation/report-snapshot.js";

function calculation(): ValuationCalculation {
  return {
    kind: "valuation-calculation",
    calculationId: "calculation-1",
    runId: "run-1",
    taskId: "analysis.fundamentals",
    attempt: 1,
    engineVersion: "2",
    methodVersion: "1",
    currency: "USD",
    valueDate: "2024-06-30",
    createdAt: "2024-07-01T00:00:00.000Z",
    request: {
      methodId: "comparable_multiples",
      purpose: "valuation",
      amountUnit: "million",
      shares: { value: 100, unit: "million" },
      inputs: {
        multipleType: "ps",
        revenue: 773.9999999999999,
        multiples: [1],
      },
      assumptions: ["Synthetic constant share count."],
      provenance: [
        { path: "/inputs", kind: "assumed", basis: "Synthetic scenario." },
        {
          path: "/shares/value",
          kind: "observed",
          basis: "Synthetic register.",
        },
      ],
      sensitivities: [],
    },
    result: {
      equityValues: [773999999.9999999],
      perShareValues: [7.739999999999999],
      shares: 100000000,
      steps: [
        { label: "Comparable metric", value: 773999999.9999999, unit: "USD" },
      ],
      diagnostics: ["Synthetic diagnostic."],
    },
    sensitivities: [
      {
        label: "Lower revenue",
        path: "/inputs/revenue",
        value: 619.1999999999999,
        basis: "Synthetic downside.",
        result: {
          equityValues: [619199999.9999999],
          perShareValues: [6.191999999999999],
          shares: 100000000,
          steps: [],
          diagnostics: [],
        },
      },
    ],
  };
}

it("captures exact report inputs and results without display formatting or shared references", () => {
  const record = calculation();
  const original = structuredClone(record);
  const snapshot = valuationCalculationSnapshot(record);
  expect(() =>
    assertJsonSchema(valuationCalculationSnapshotSchema, snapshot, "snapshot"),
  ).not.toThrow();
  expect(snapshot).toEqual({
    calculationId: "calculation-1",
    engineVersion: "2",
    amountUnit: "million",
    shareUnit: "million",
    inputs: [
      {
        path: "/inputs",
        kind: "assumed",
        basis: "Synthetic scenario.",
        value: {
          multipleType: "ps",
          revenue: 773.9999999999999,
          multiples: [1],
        },
      },
      {
        path: "/shares/value",
        kind: "observed",
        basis: "Synthetic register.",
        value: 100,
      },
    ],
    assumptions: ["Synthetic constant share count."],
    steps: [
      { label: "Comparable metric", value: 773999999.9999999, unit: "USD" },
    ],
    perShareValues: [7.739999999999999],
    sensitivities: [
      {
        label: "Lower revenue",
        path: "/inputs/revenue",
        value: 619.1999999999999,
        basis: "Synthetic downside.",
        perShareValues: [6.191999999999999],
      },
    ],
    diagnostics: ["Synthetic diagnostic."],
  });
  (snapshot.inputs[0]!.value as { revenue: number }).revenue = 0;
  snapshot.steps[0]!.value = 0;
  snapshot.sensitivities[0]!.perShareValues[0] = 0;
  expect(record).toEqual(original);
});

it("rejects display strings in place of structured calculation data", () => {
  const snapshot = valuationCalculationSnapshot(calculation());
  expect(() =>
    assertJsonSchema(
      valuationCalculationSnapshotSchema,
      { ...snapshot, steps: ["倍数法经济指标=7.74 亿USD"] },
      "snapshot",
    ),
  ).toThrow(/steps\/0 must be object/);
});
