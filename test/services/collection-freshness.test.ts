import { describe, expect, it } from "vitest";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import {
  applyCollectionFreshness,
  collectionFreshnessMs,
} from "../../src/services/collection-freshness.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-27",
  cutoff: "2026-10-26T16:30:00.000Z",
};
const day = 86400000;
function packet(
  interval: "1d" | "1wk" | "1mo",
  asOf: string,
): DataEnvelope<CollectedTableData> {
  return {
    dataset: "market",
    data: {
      table: "market.fixture",
      title: "Fixture",
      interval,
      columns: {},
      rows: [],
    },
    source: {
      provider: "fixture",
      url: "https://example.com",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf,
    availableAt: null,
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    ageMs: Date.parse(scope.cutoff) - Date.parse(asOf),
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}

describe("collection freshness budgets", () => {
  it("accepts the latest completed daily, weekly and monthly bars without treating elapsed weekends or month length as lag", () => {
    for (const [interval, asOf] of [
      ["1d", "2026-10-26T07:30:00.000Z"],
      ["1wk", "2026-10-23T07:30:00.000Z"],
      ["1mo", "2026-09-30T07:30:00.000Z"],
    ] as const)
      expect(collectionFreshnessMs(scope, packet(interval, asOf))).toBe(0);
  });

  it("counts a missing completed week or month as a lagged period", () => {
    expect(
      collectionFreshnessMs(scope, packet("1wk", "2026-10-16T07:30:00.000Z")),
    ).toBe(day);
    expect(
      collectionFreshnessMs(scope, packet("1mo", "2026-08-31T07:30:00.000Z")),
    ).toBe(day);
  });

  it("uses the configured fundamentals budget and preserves a source's existing stale warning", () => {
    const frame = packet("1mo", "2026-06-30T15:59:59.999Z");
    frame.dataset = "fundamentals";
    frame.data.table = "financial.indicators";
    applyCollectionFreshness(scope, frame, 200 * day);
    expect(frame.stale).toBe(false);
    applyCollectionFreshness(scope, frame, 0);
    expect(frame.stale).toBe(true);
    expect(frame.gaps).toContainEqual(
      expect.objectContaining({ code: "stale" }),
    );
    applyCollectionFreshness(scope, frame, 200 * day);
    expect(frame.stale).toBe(true);
  });

  it("counts completed UTC weekdays for global prices without using China's holiday calendar", () => {
    const frame = packet("1d", "2026-10-23T23:59:59.999Z");
    frame.data.attributes = { calendar: "global_weekdays_utc" };
    expect(
      collectionFreshnessMs(
        { ...scope, cutoff: "2026-10-26T17:00:00.000Z" },
        frame,
      ),
    ).toBe(0);
    expect(
      collectionFreshnessMs(
        { ...scope, cutoff: "2026-10-27T01:00:00.000Z" },
        frame,
      ),
    ).toBe(day);
    frame.asOf = "2026-09-30T23:59:59.999Z";
    expect(
      collectionFreshnessMs(
        { ...scope, date: "2026-10-03", cutoff: "2026-10-02T23:59:59.999Z" },
        frame,
      ),
    ).toBe(2 * day);
  });

  it("waits for UTC month end before requiring a new global monthly bar", () => {
    const frame = packet("1mo", "2026-09-30T23:59:59.999Z");
    frame.data.attributes = { calendar: "global_weekdays_utc" };
    expect(
      collectionFreshnessMs(
        { ...scope, date: "2026-11-01", cutoff: "2026-10-31T17:00:00.000Z" },
        frame,
      ),
    ).toBe(0);
    expect(
      collectionFreshnessMs(
        { ...scope, date: "2026-11-01", cutoff: "2026-11-01T00:00:00.000Z" },
        frame,
      ),
    ).toBe(day);
  });
});
