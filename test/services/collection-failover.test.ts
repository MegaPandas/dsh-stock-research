import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type {
  CollectionTask,
  CollectedTableData,
} from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { HttpClient } from "../../src/data/http.js";
import { parseSourceJson } from "../../src/data/source.js";
import * as market from "../../src/data/collection-market.js";
import * as financial from "../../src/data/collection-financials.js";
import * as macro from "../../src/data/collection-macro.js";
import * as benchmarks from "../../src/data/collection-benchmarks.js";
import * as bonds from "../../src/data/collection-bonds.js";
import { CollectionService } from "../../src/services/collection.js";
import type { QueryService } from "../../src/services/query.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T10:00:00.000Z",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function table(
  provider: string,
  close: number | null = 10,
): DataEnvelope<CollectedTableData> {
  return {
    dataset: "market",
    source: {
      provider,
      url: `https://${provider}.example/prices`,
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    data: {
      table: "market.daily",
      title: "Daily",
      interval: "1d",
      currency: "CNY",
      adjustment: "unadjusted",
      columns: Object.fromEntries(
        ["open", "high", "low", "close", "volume"].map((key) => [
          key,
          { label: key, unit: key === "volume" ? "shares" : "CNY/share" },
        ]),
      ),
      rows: [
        {
          date: scope.date,
          asOf: "2026-10-28T07:00:00.000Z",
          availableAt: null,
          complete: true,
          values: { open: 10, high: 20, low: 5, close, volume: 100 },
        },
      ],
    },
    asOf: "2026-10-28T07:00:00.000Z",
    availableAt: null,
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    ageMs: 10_800_000,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}

function setup(enabledSources = ["eastmoney-market", "tencent"]) {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-failover-"));
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 20,
  });
  const http = new HttpClient({
    timeoutMs: 120_000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const candidate = (provider: string): CollectionTask => ({
    id: "market.daily",
    dataset: "market",
    provider,
    enabledBy: [provider === "eastmoney" ? "eastmoney-market" : provider],
    async run(signal) {
      const raw = parseSourceJson(
        await http
          .forSource(provider)
          .getText(`https://${provider}.example/prices`, {
            ...(signal && { signal }),
          }),
      );
      const result = table(provider, raw.close as number | null);
      if (raw.short)
        result.gaps.push({
          code: "missing",
          field: "/data/rows",
          detail: "Requested history is incomplete.",
        });
      return result;
    },
  });
  // Isolate the external source recipes; exercise the real scheduler, HTTP and cache.
  vi.spyOn(market, "createChinaMarketTasks").mockReturnValue([
    candidate("eastmoney"),
    candidate("tencent"),
  ]);
  vi.spyOn(financial, "createChinaFinancialTasks").mockReturnValue([]);
  vi.spyOn(macro, "createChinaMacroTasks").mockReturnValue([]);
  vi.spyOn(benchmarks, "createBenchmarkMarketTasks").mockReturnValue([]);
  vi.spyOn(bonds, "createBenchmarkBondTasks").mockReturnValue([]);
  const service = new CollectionService(
    http,
    cache,
    { query: vi.fn() as QueryService["query"] },
    {
      enabledSources,
      freshness: { market: 86_400_000, fundamentals: 0, macro: 0 },
      secCiks: {},
      ttl: { market: 60_000, fundamentals: 0, macro: 0, research: 0 },
    },
  );
  cleanups.push(async () => {
    await service.close();
    await http.close();
    cache.close();
    fs.rmSync(directory, { recursive: true });
  });
  return { service, cache };
}

const response = (close: number | null, short = false) =>
  new Response(JSON.stringify({ close, short }));

describe("collection source failover", () => {
  it("does not contact the standby for complete primary data or its cached copy", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(10));
    const { service } = setup();
    const first = await service.collect(scope);
    const second = await service.collect(scope);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.packets[0]!.envelope.source.provider).toBe("eastmoney");
    expect(second.packets).toEqual(first.packets);
  });

  it.each(["missing field", "short history"])(
    "replaces a whole table with complete standby data after %s",
    async (problem) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) =>
          String(input).includes("eastmoney")
            ? response(
                problem === "missing field" ? null : 10,
                problem === "short history",
              )
            : response(12),
        );
      const { service } = setup();
      const result = await service.collect(scope);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.packets[0]!.envelope.source.provider).toBe("tencent");
      expect(result.packets[0]!.envelope.data.rows[0]!.values.close).toBe(12);
      expect(result.failures).toContainEqual(
        expect.objectContaining({
          provider: "eastmoney",
          code: "DATA_INSUFFICIENT",
        }),
      );
    },
  );

  it("retains partial primary data when standby fails, and seeks missing coverage on the next cached collection", async () => {
    let recovered = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("eastmoney")
          ? response(10, true)
          : recovered
            ? response(12)
            : new Response("unavailable", { status: 503 }),
      );
    const { service } = setup();
    const partial = await service.collect(scope);
    expect(partial.packets[0]!.envelope.source.provider).toBe("eastmoney");
    expect(partial.packets[0]!.envelope.gaps).toContainEqual(
      expect.objectContaining({ code: "missing" }),
    );
    recovered = true;
    const complete = await service.collect(scope);
    expect(complete.packets[0]!.envelope.source.provider).toBe("tencent");
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("eastmoney")),
    ).toHaveLength(1);
  });

  it("adopts a more complete standby even when both histories are short", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("eastmoney")
          ? response(null, true)
          : response(12, true),
      );
    const { service } = setup();
    const first = await service.collect(scope);
    expect(first.packets[0]!.envelope.source.provider).toBe("tencent");
    expect(first.packets[0]!.envelope.gaps).toContainEqual(
      expect.objectContaining({ code: "missing" }),
    );
    const cached = await service.collect(scope);
    expect(cached.packets[0]!.envelope.source.provider).toBe("tencent");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid JSON", "empty response", "rate limit"])(
    "uses standby after %s",
    async (failure) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("tencent")) return response(12);
        if (failure === "rate limit")
          return new Response("limited", { status: 429 });
        return new Response(
          failure === "empty response" ? "" : "<html>bad</html>",
        );
      });
      const result = await setup().service.collect(scope);
      expect(result.packets[0]!.envelope.source.provider).toBe("tencent");
      expect(
        result.diagnostics!.attempts.map((attempt) => attempt.outcome),
      ).toEqual(["failed", "success"]);
    },
  );

  it("reserves time for standby when primary hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      if (String(input).includes("tencent")) return response(12);
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        ),
      );
    });
    const work = setup().service.collect(scope);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await work;
    expect(result.packets[0]!.envelope.source.provider).toBe("tencent");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ provider: "eastmoney", code: "TimeoutError" }),
    );
  });

  it("retries a transient ordinary-table failure once and respects cancellation during retry delay", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockImplementation(async () => response(10));
    const { service, cache } = setup(["eastmoney-market"]);
    const work = service.collect(scope);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await work).packets[0]!.envelope.source.provider).toBe("eastmoney");
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.spyOn(cache, "get").mockReturnValue(undefined);
    fetch.mockImplementation(async () => new Response("down", { status: 503 }));
    const controller = new AbortController();
    const cancelled = service.collect(scope, controller.signal);
    const check = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await check;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds an ordinary table at 120 seconds when every source hangs", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (_input, options) =>
          new Promise((_resolve, reject) =>
            options!.signal!.addEventListener(
              "abort",
              () => reject(options!.signal!.reason),
              { once: true },
            ),
          ),
      );
    const work = setup().service.collect(scope);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await work;
    expect(result.packets).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        code: "TimeoutError",
        detail: expect.stringContaining("120-second budget"),
      }),
    );
    expect(
      Date.parse(result.diagnostics!.finishedAt) -
        Date.parse(result.diagnostics!.startedAt),
    ).toBe(120_000);
  });

  it("retries only the transiently failed candidate in a mixed failure chain", async () => {
    vi.useFakeTimers();
    let standbyCalls = 0;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).includes("eastmoney"))
          return new Response("bad JSON");
        return ++standbyCalls === 1
          ? new Response("unavailable", { status: 503 })
          : response(12);
      });
    const work = setup().service.collect(scope);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await work;
    expect(result.packets[0]!.envelope.source.provider).toBe("tencent");
    expect(standbyCalls).toBe(2);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("eastmoney")),
    ).toHaveLength(1);
  });

  it("propagates storage failures without disguising them as source failures", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(10));
    const { service, cache } = setup();
    const error = new ResearchError("STORAGE_FAILED", "cache write failed");
    vi.spyOn(cache, "set").mockImplementation(() => {
      throw error;
    });
    await expect(service.collect(scope)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
