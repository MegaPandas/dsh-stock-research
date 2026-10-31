import { describe, expect, it } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type {
  CollectedTableData,
  CollectionOptions,
  CollectionSnapshot,
  CollectionTask,
} from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import {
  applyCollectionFreshness,
  collectionFreshnessMs,
  rebaseCollectionEnvelope,
} from "../../src/services/collection/freshness.js";
import { CollectionCache } from "../../src/services/collection/cache.js";
import { CollectionService } from "../../src/services/collection/index.js";
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

  it.each([
    ["2026-10-19", "2026-10-29", 8],
    ["2026-10-20", "2026-10-30", 8],
    ["2026-10-21", "2026-10-31", 7],
    ["2026-10-22", "2026-11-01", 6],
    ["2026-10-23", "2026-11-02", 6],
    ["2026-10-24", "2026-11-03", 7],
    ["2026-10-25", "2026-11-04", 8],
    ["2024-02-28", "2024-03-01", 2],
    ["2023-12-29", "2024-01-02", 2],
    ["1969-12-31", "1970-01-02", 2],
    ["2016-10-30", "2026-10-30", 2610],
  ] as const)(
    "counts UTC weekdays from %s through %s as %i",
    (asOf, cutoff, weekdays) => {
      const frame = packet("1d", `${asOf}T23:59:59.999Z`);
      frame.data.attributes = { calendar: "global_weekdays_utc" };
      expect(
        collectionFreshnessMs(
          { ...scope, date: cutoff, cutoff: `${cutoff}T23:59:59.999Z` },
          frame,
        ),
      ).toBe(weekdays * day);
    },
  );

  it.each([
    ["2026-10-25T23:59:59.999Z", 0],
    ["2026-10-26T23:59:59.998Z", 0],
    ["2026-10-26T23:59:59.999Z", 1],
    ["2026-10-27T00:00:00.000Z", 1],
    ["2026-10-22T23:59:59.999Z", 0],
  ] as const)(
    "includes only completed days at cutoff %s",
    (cutoff, weekdays) => {
      const frame = packet("1d", "2026-10-23T23:59:59.999Z");
      frame.data.attributes = { calendar: "global_weekdays_utc" };
      expect(collectionFreshnessMs({ ...scope, cutoff }, frame)).toBe(
        weekdays * day,
      );
    },
  );

  it("rebases natural age and cutoff without replacing source timestamps or existing limitations", () => {
    const frame = packet("1d", "2026-10-23T23:59:59.999Z");
    frame.data.attributes = { calendar: "global_weekdays_utc" };
    const original = structuredClone(frame);
    const finalScope = { ...scope, cutoff: "2026-10-26T23:59:59.999Z" };
    rebaseCollectionEnvelope(finalScope, frame, 0);
    expect(frame).toMatchObject({
      cutoff: finalScope.cutoff,
      ageMs: 3 * day,
      stale: true,
      asOf: original.asOf,
      availableAt: original.availableAt,
      retrievedAt: original.retrievedAt,
      source: original.source,
      data: original.data,
    });
    const gaps = structuredClone(frame.gaps);
    rebaseCollectionEnvelope(finalScope, frame, 100 * day);
    expect(frame.stale).toBe(true);
    expect(frame.gaps).toEqual(gaps);
  });

  it("uses market budgets for cached and finalized valuation history while retaining the cached capture", async () => {
    const capturedScope = { ...scope, cutoff: "2026-10-27T01:00:00.000Z" };
    const finalScope = { ...scope, cutoff: "2026-10-27T03:00:00.000Z" };
    const options: CollectionOptions = {
      enabledSources: [],
      freshness: { market: day, fundamentals: 0, macro: 0 },
      ttl: { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 0 },
    };
    const source = packet("1d", "2026-10-23T23:59:59.999Z");
    source.dataset = "fundamentals";
    source.data.table = "valuation.history";
    source.data.attributes = { calendar: "global_weekdays_utc" };
    source.cutoff = capturedScope.cutoff;
    source.retrievedAt = capturedScope.cutoff;
    source.ageMs = Date.parse(capturedScope.cutoff) - Date.parse(source.asOf);
    const task: CollectionTask = {
      id: "valuation.history",
      dataset: "fundamentals",
      provider: "fixture",
      enabledBy: [],
      run: async () => structuredClone(source),
    };
    const cache = new SqliteCache({ path: ":memory:", maxEntries: 1 });
    const cached = new CollectionCache(cache, options);
    const collection = new CollectionService(() => [], cache, options);
    try {
      cached.write(capturedScope, task, source);
      const hit = cached.read(finalScope, task)!;
      const snapshot: CollectionSnapshot = {
        schemaVersion: 1,
        scope: structuredClone(capturedScope),
        packets: [{ id: task.id, envelope: structuredClone(source) }],
        failures: [],
      };
      collection.finalizeScope(snapshot, finalScope);
      expect(hit).toMatchObject({
        cutoff: finalScope.cutoff,
        retrievedAt: capturedScope.cutoff,
        stale: false,
        gaps: [],
      });
      expect(snapshot.packets[0]!.envelope).toEqual(hit);
      expect(cached.read(capturedScope, task)).toEqual(source);
    } finally {
      try {
        await collection.close();
      } finally {
        cache.close();
      }
    }
  });
});
