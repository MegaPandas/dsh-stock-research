import { describe, expect, it } from "vitest";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import {
  collectionCoverageIssue,
  improvesCollectionCoverage,
} from "../../src/services/collection-quality.js";

function envelope(
  table: string,
  values: Record<string, number | null>,
): DataEnvelope<CollectedTableData> {
  const time = "2026-10-26T16:00:00.000Z";
  return {
    dataset: table.startsWith("financial.") ? "fundamentals" : "market",
    data: {
      table,
      title: table,
      ...(table.startsWith("financial.") ? {} : { interval: "1d" as const }),
      columns: Object.fromEntries(
        Object.keys(values).map((field) => [
          field,
          { label: field, unit: "CNY" },
        ]),
      ),
      rows: [
        {
          date: "2026-10-26",
          asOf: time,
          availableAt: null,
          complete: true,
          values,
        },
      ],
    },
    source: {
      provider: "fixture",
      url: "https://example.invalid/data",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: time,
    availableAt: null,
    retrievedAt: time,
    cutoff: time,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data/rows",
        detail: "Historical publication times are not established.",
      },
    ],
  };
}

describe("collection source coverage", () => {
  it.each(["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"])(
    "accepts reported income using %s with parent profit",
    (revenue) => {
      expect(
        collectionCoverageIssue(
          envelope("financial.income", { [revenue]: 100, PARENT_NETPROFIT: 0 }),
        ),
      ).toBeUndefined();
    },
  );

  it("identifies absent core financial data even when a table contains rows", () => {
    const result = collectionCoverageIssue(
      envelope("financial.income", {
        OPERATE_INCOME: 100,
        PARENT_NETPROFIT: null,
      }),
    );
    expect(result).toContain("PARENT_NETPROFIT");
  });

  it("requires stock OHLCV while allowing close-only benchmarks", () => {
    expect(
      collectionCoverageIssue(envelope("market.daily", { close: 10 })),
    ).toContain("open");
    expect(
      collectionCoverageIssue(envelope("benchmark.dxy.daily", { close: 100 })),
    ).toBeUndefined();
  });

  it("does not reject missing optional stock quantities or unverified publication times", () => {
    const data = envelope("market.daily", {
      open: 9,
      high: 11,
      low: 8,
      close: 10,
      volume: 1000,
      amount: null,
    });
    data.gaps.push({
      code: "missing",
      field: "/data/rows/0/values/amount",
      detail: "Amount is unavailable.",
    });
    expect(collectionCoverageIssue(data)).toBeUndefined();
  });

  it("recognizes an explicitly incomplete history window", () => {
    const data = envelope("benchmark.usdcny.daily", { close: 7 });
    data.gaps.push({
      code: "missing",
      field: "/data/rows",
      detail: "Only 10 of the requested 60 observations are available.",
    });
    expect(collectionCoverageIssue(data)).toBe(
      "Only 10 of the requested 60 observations are available.",
    );
  });

  it("recognizes stale observations as insufficient coverage", () => {
    const data = envelope("benchmark.usdcny.daily", { close: 7 });
    data.stale = true;
    expect(collectionCoverageIssue(data)).toBeDefined();
  });

  it("keeps existing partial coverage when a fuller candidate is older or stale", () => {
    const current = envelope("financial.income", {
      OPERATE_INCOME: 100,
      PARENT_NETPROFIT: null,
    });
    const candidate = envelope("financial.income", {
      OPERATE_INCOME: 100,
      PARENT_NETPROFIT: 20,
    });
    expect(improvesCollectionCoverage(current, candidate)).toBe(true);
    candidate.stale = true;
    expect(improvesCollectionCoverage(current, candidate)).toBe(false);
    candidate.stale = false;
    candidate.asOf = "2026-09-30T16:00:00.000Z";
    expect(improvesCollectionCoverage(current, candidate)).toBe(false);
  });
});
