import { describe, expect, it } from "vitest";
import {
  collectedEnvelope,
  collectionRow,
} from "../../src/data/collection-utils.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-01",
  cutoff: "2026-10-01T00:00:00.000Z",
};

describe("collected table missing values", () => {
  it("records an absent column once and preserves every value and null", () => {
    const rows = Array.from({ length: 60 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1))
        .toISOString()
        .slice(0, 10);
      return collectionRow(
        date,
        { close: index, amount: null, volume: index % 2 ? 0 : null },
        scope,
      );
    });
    const original = structuredClone(rows);
    const envelope = collectedEnvelope(
      scope,
      "market",
      {
        table: "benchmark.fixture.daily",
        title: "Fixture",
        rows,
        columns: {
          close: { label: "Close", unit: "CNY" },
          amount: { label: "Amount", unit: "CNY" },
          volume: { label: "Volume", unit: "shares" },
        },
      },
      "fixture",
      "urn:fixture",
      scope.cutoff,
    );
    expect(envelope.data.rows).toEqual(original);
    expect(envelope.gaps.filter((gap) => gap.code === "missing")).toEqual([
      {
        code: "missing",
        field: "/data/columns/amount",
        detail: "Amount is absent from all observations.",
      },
    ]);
    expect(
      envelope.gaps.filter((gap) => gap.code === "unverified_time"),
    ).toHaveLength(1);
  });
});
