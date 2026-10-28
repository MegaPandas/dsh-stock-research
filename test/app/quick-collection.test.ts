import { describe, expect, it } from "vitest";
import {
  attachCollection,
  requireCollectionData,
} from "../../src/app/collection-input.js";
import { createQuickInput } from "../../src/app/quick-plan.js";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-26",
  cutoff: "2026-10-26T08:00:00.000Z",
};
const policy = {
  freshness: { market: 86400000, fundamentals: 0, macro: 0 },
  secCiks: {},
};
function snapshot(): CollectionSnapshot {
  return {
    schemaVersion: 1,
    scope,
    packets: [
      {
        id: "market.daily",
        envelope: {
          dataset: "market",
          data: {
            table: "market.daily",
            title: "人工日线",
            columns: {
              close: { label: "收盘价", unit: "CNY/share", price: true },
            },
            rows: [
              {
                date: scope.date,
                asOf: "2026-10-26T07:30:00.000Z",
                availableAt: null,
                complete: true,
                values: { close: 100 },
              },
            ],
          },
          source: {
            provider: "tencent",
            url: "https://example.com/daily",
            adapterVersion: "1",
            normalizationVersion: "1",
          },
          asOf: "2026-10-26T07:30:00.000Z",
          availableAt: null,
          retrievedAt: "2026-10-26T07:59:00.000Z",
          cutoff: scope.cutoff,
          ageMs: 1800000,
          stale: false,
          historicalKnowledge: "unverified",
          gaps: [],
        },
      },
    ],
    failures: [],
  };
}

describe("pre-analysis collection input", () => {
  it("requires successful daily observations before creating analysis Agents", () => {
    const input = snapshot();
    expect(() => requireCollectionData(input)).not.toThrow();
    input.packets = [];
    input.failures.push({
      id: "market.daily",
      provider: "tencent",
      code: "SOURCE_UNAVAILABLE",
      detail: "The source is unavailable.",
    });
    expect(() => requireCollectionData(input)).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining("The source is unavailable."),
      }),
    );
  });

  it("records a full snapshot and keeps collection versions separate from original adapters", () => {
    const prepared = snapshot();
    const input = createQuickInput(scope, policy, []);
    input.versions.normalization["market/tencent"] = "2";
    const result = attachCollection(input, prepared);
    expect(
      result.inputs.find((item) => item.name === "stock-research:collection")!
        .content,
    ).toEqual(prepared);
    expect(result.versions.normalization["market/tencent"]).toBe("2");
    expect(result.versions.normalization["collection/market/tencent"]).toBe(
      "1",
    );
    prepared.packets[0]!.envelope.data.rows[0]!.values.close = 999;
    const saved = result.inputs.find(
      (item) => item.name === "stock-research:collection",
    )!.content as unknown as CollectionSnapshot;
    expect(saved.packets[0]!.envelope.data.rows[0]!.values.close).toBe(100);
    expect(
      result.definition.tasks.some((task) => task.id === "analysis.news"),
    ).toBe(false);
  });
});
