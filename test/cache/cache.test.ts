import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheKey, SqliteCache } from "../../src/cache/index.js";
import type { JsonValue, QueryCacheKey } from "../../src/contracts/cache.js";
import type { MarketData } from "../../src/contracts/data.js";
import { MARKET_FIXTURE } from "../fixtures/market.js";

const KEY: QueryCacheKey = {
  provider: "fixture",
  securityId: "US:NVDA",
  dataset: "market",
  cutoff: MARKET_FIXTURE.cutoff,
  parameters: {
    interval: "1d",
    adjustment: "unadjusted",
    currency: "USD",
    periods: [5, 20],
    range: { from: "2024-01-02", to: "2024-01-08" },
  },
  adapterVersion: "1",
  normalizationVersion: "1",
};

describe("query cache keys", () => {
  it("normalizes nested object order without changing the input", () => {
    const reordered: QueryCacheKey = {
      ...KEY,
      parameters: {
        range: { to: "2024-01-08", from: "2024-01-02" },
        periods: [5, 20],
        currency: "USD",
        adjustment: "unadjusted",
        interval: "1d",
      },
    };
    const original = structuredClone(reordered);
    expect(createCacheKey(reordered)).toBe(createCacheKey(KEY));
    expect(reordered).toEqual(original);
  });

  it.each<Partial<QueryCacheKey>>([
    { provider: "other-provider" },
    { securityId: "US:MSFT" },
    { dataset: "fundamentals" },
    { cutoff: "2024-01-09T22:00:00.000Z" },
    { adapterVersion: "2" },
    { normalizationVersion: "2" },
    { parameters: { ...KEY.parameters, interval: "1wk" } },
    { parameters: { ...KEY.parameters, adjustment: "split_adjusted" } },
    { parameters: { ...KEY.parameters, currency: "CNY" } },
    { parameters: { ...KEY.parameters, periods: [20, 5] } },
    { parameters: { ...KEY.parameters, periods: ["5", 20] } },
  ])("keeps changed query semantics separate: %j", (change) => {
    expect(createCacheKey({ ...KEY, ...change })).not.toBe(createCacheKey(KEY));
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol("value"),
    () => 1,
    new Date("2024-01-02"),
    new Map([["value", 1]]),
    new Array(1),
  ])("rejects values JSON would lose or rewrite: %s", (value) => {
    expect(() =>
      createCacheKey({
        ...KEY,
        parameters: { value: value as JsonValue },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects cycles and symbol properties", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [cycle, { [Symbol("hidden")]: 1 }]) {
      expect(() =>
        createCacheKey({ ...KEY, parameters: { value: value as JsonValue } }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});

describe("SqliteCache", () => {
  let directory: string;
  let path: string;
  let now: number;
  const caches: SqliteCache[] = [];

  function open(maxEntries = 2): SqliteCache {
    const cache = new SqliteCache({ path, maxEntries });
    caches.push(cache);
    return cache;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dsh-cache-test-"));
    path = join(directory, "cache.sqlite");
    now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    for (const cache of caches.splice(0)) cache.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists the complete normalized envelope across reopen and returns independent data", () => {
    const cache = open();
    const envelope = structuredClone(MARKET_FIXTURE);
    cache.set(KEY, envelope, 100);
    envelope.data.bars[0]!.close = 999;
    cache.close();
    now += 50;
    const reopened = open();
    const result = reopened.get<MarketData>(KEY)!;
    expect(result).toEqual(MARKET_FIXTURE);
    result.data.bars[0]!.close = 888;
    expect(reopened.get(KEY)).toEqual(MARKET_FIXTURE);
    expect(reopened.get({ ...KEY, provider: "different" })).toBeUndefined();
  });

  it("expires exactly at the TTL boundary and allows zero TTL to replace an existing value", () => {
    const cache = open();
    cache.set(KEY, MARKET_FIXTURE, 10);
    now += 9;
    expect(cache.get(KEY)).toEqual(MARKET_FIXTURE);
    now += 1;
    expect(cache.get(KEY)).toBeUndefined();
    cache.set(KEY, MARKET_FIXTURE, 100);
    cache.set(KEY, MARKET_FIXTURE, 0);
    expect(cache.get(KEY)).toBeUndefined();
  });

  it("applies a smaller capacity and expiration immediately on reopen", () => {
    const cache = open(3);
    const kept = { ...KEY, securityId: "US:KEPT" };
    const expired = { ...KEY, securityId: "US:EXPIRED" };
    cache.set(KEY, MARKET_FIXTURE, 100);
    cache.set(kept, MARKET_FIXTURE, 100);
    cache.set(expired, MARKET_FIXTURE, 1);
    cache.close();
    now += 2;
    const reopened = open(1);
    expect(reopened.get(KEY)).toBeUndefined();
    expect(reopened.get(kept)).toEqual(MARKET_FIXTURE);
    expect(reopened.get(expired)).toBeUndefined();
  });

  it("evicts by write order, including overwrites, while reads do not extend retention", () => {
    const cache = open();
    const a = { ...KEY, securityId: "US:A" };
    const b = { ...KEY, securityId: "US:B" };
    const c = { ...KEY, securityId: "US:C" };
    const d = { ...KEY, securityId: "US:D" };
    cache.set(a, MARKET_FIXTURE, 100);
    cache.set(b, MARKET_FIXTURE, 100);
    expect(cache.get(a)).toEqual(MARKET_FIXTURE);
    cache.set(c, MARKET_FIXTURE, 100);
    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toEqual(MARKET_FIXTURE);
    cache.set(b, { ...MARKET_FIXTURE, stale: true }, 100);
    cache.set(d, MARKET_FIXTURE, 100);
    expect(cache.get(c)).toBeUndefined();
    expect(cache.get(b)?.stale).toBe(true);
    expect(cache.get(d)).toEqual(MARKET_FIXTURE);
  });

  it("removes expired entries before evicting live ones", () => {
    const cache = open();
    const expired = { ...KEY, securityId: "US:EXPIRED" };
    const added = { ...KEY, securityId: "US:ADDED" };
    cache.set(KEY, MARKET_FIXTURE, 100);
    cache.set(expired, MARKET_FIXTURE, 1);
    now += 2;
    cache.set(added, MARKET_FIXTURE, 100);
    expect(cache.get(KEY)).toEqual(MARKET_FIXTURE);
    expect(cache.get(expired)).toBeUndefined();
    expect(cache.get(added)).toEqual(MARKET_FIXTURE);
  });

  it("rejects a non-JSON payload without replacing the previous entry", () => {
    const cache = open();
    cache.set(KEY, MARKET_FIXTURE, 100);
    expect(() =>
      cache.set(KEY, { ...MARKET_FIXTURE, data: { value: NaN } }, 100),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(cache.get(KEY)).toEqual(MARKET_FIXTURE);
  });

  it("propagates SQLite write-lock errors without changing earlier data", () => {
    const cache = open();
    cache.set(KEY, MARKET_FIXTURE, 100);
    const other = new DatabaseSync(path);
    try {
      other.exec("BEGIN EXCLUSIVE");
      expect(() =>
        cache.set(KEY, { ...MARKET_FIXTURE, stale: true }, 100),
      ).toThrowError(/locked/);
      other.exec("ROLLBACK");
      expect(cache.get(KEY)).toEqual(MARKET_FIXTURE);
      cache.set(KEY, { ...MARKET_FIXTURE, stale: true }, 100);
      expect(cache.get(KEY)?.stale).toBe(true);
    } finally {
      if (other.isTransaction) other.exec("ROLLBACK");
      other.close();
    }
  });

  it("rolls back a failed SQLite write and remains usable", () => {
    const cache = open();
    cache.set(KEY, MARKET_FIXTURE, 100);
    const other = new DatabaseSync(path);
    try {
      // Inject a real SQLite statement failure without inspecting private class state.
      const table = other
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get()!.name as string;
      const identifier = `"${table.replaceAll('"', '""')}"`;
      other.exec(`CREATE TRIGGER reject_cache_write AFTER INSERT ON ${identifier}
        BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
      expect(() =>
        cache.set(KEY, { ...MARKET_FIXTURE, stale: true }, 100),
      ).toThrowError(/injected storage failure/);
      expect(cache.get(KEY)).toEqual(MARKET_FIXTURE);
      other.exec("DROP TRIGGER reject_cache_write");
      cache.set(KEY, { ...MARKET_FIXTURE, stale: true }, 100);
      expect(cache.get(KEY)?.stale).toBe(true);
    } finally {
      other.close();
    }
  });

  it("does not replace an invalid database or create missing parent directories", () => {
    writeFileSync(path, "not a sqlite database");
    expect(() => open()).toThrowError(/not a database/);
    expect(readFileSync(path, "utf8")).toBe("not a sqlite database");
    expect(
      () =>
        new SqliteCache({
          path: join(directory, "missing", "cache.sqlite"),
          maxEntries: 2,
        }),
    ).toThrowError(/unable to open database/);
  });

  it("closes repeatedly and rejects subsequent reads and writes", () => {
    const cache = open();
    cache.close();
    expect(() => cache.close()).not.toThrow();
    expect(() => cache.get(KEY)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(() => cache.set(KEY, MARKET_FIXTURE, 100)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid capacity: %s",
    (maxEntries) => {
      expect(() => open(maxEntries)).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    },
  );

  it.each([-1, NaN, Infinity])("rejects an invalid TTL: %s", (ttl) => {
    const cache = open();
    expect(() => cache.set(KEY, MARKET_FIXTURE, ttl)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(cache.get(KEY)).toBeUndefined();
  });
});
