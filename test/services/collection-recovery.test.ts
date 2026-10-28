import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type {
  CollectionProgress,
  CollectionRecord,
} from "../../src/contracts/collection.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import { HttpClient } from "../../src/data/http.js";
import { CollectionService } from "../../src/services/collection.js";
import type { QueryService } from "../../src/services/query.js";
import { CollectionSnapshotStore } from "../../src/storage/collection-snapshots.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { requireCollectionData } from "../../src/app/collection-input.js";
import { CN_SECURITY } from "../fixtures/market.js";
import { deferred } from "../fixtures/runtime-host.js";

const scope: ResearchScope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T10:00:00.000Z",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function setup(
  enabledSources = ["eastmoney-market", "tencent"],
  requireDailyMarket = true,
) {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-recovery-"));
  const root = new DataRoot(directory);
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 100,
  });
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const query = vi.fn<QueryService["query"]>();
  const service = new CollectionService(
    http,
    cache,
    { query: query as QueryService["query"] },
    {
      enabledSources,
      requireDailyMarket,
      freshness: { market: 86400000, fundamentals: 0, macro: 0 },
      secCiks: {},
      ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
    },
    new CollectionSnapshotStore(root),
  );
  cleanups.push(async () => {
    await service.close();
    await http.close();
    cache.close();
    root.close();
    fs.rmSync(directory, { recursive: true });
  });
  const records = (): CollectionRecord[] => {
    const path = join(directory, "collections");
    return fs.existsSync(path)
      ? fs
          .readdirSync(path)
          .map((name) => JSON.parse(fs.readFileSync(join(path, name), "utf8")))
      : [];
  };
  return { service, query, records };
}

function networkError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });
}

function tencentResponse(url: URL) {
  const [symbol, period] = url.searchParams.get("param")!.split(",");
  const date =
    period === "day"
      ? "2026-10-28"
      : period === "week"
        ? "2026-10-19"
        : "2026-09-01";
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        [symbol!]: { [period!]: [[date, "100", "102", "103", "99", "10"]] },
      },
    }),
  );
}

describe("collection recovery and scheduling", () => {
  it("recovers required daily data in one delayed round before collecting other tables", async () => {
    let standbyCalls = 0;
    let dailyReady = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        const daily =
          url.searchParams.get("klt") === "101" ||
          url.searchParams.get("param")?.includes(",day,");
        if (!daily) expect(dailyReady).toBe(true);
        if (url.hostname.includes("gtimg")) {
          if (daily && ++standbyCalls === 1) throw networkError();
          if (daily) dailyReady = true;
          return tencentResponse(url);
        }
        throw networkError();
      });
    const { service, records } = setup();
    const progress: CollectionProgress[] = [];
    const result = await service.collect(scope, undefined, (value) =>
      progress.push(value),
    );
    expect(standbyCalls).toBe(2);
    expect(result.packets.map((packet) => packet.id)).toEqual([
      "market.daily",
      "market.weekly",
      "market.monthly",
    ]);
    expect(
      fetch.mock.calls.filter(
        ([input]) => new URL(String(input)).searchParams.get("klt") === "101",
      ),
    ).toHaveLength(2);
    expect(
      result.failures.filter((failure) => failure.id === "market.daily"),
    ).toHaveLength(3);
    expect(
      result.failures.find(
        (failure) =>
          failure.id === "market.daily" &&
          failure.provider === "eastmoney" &&
          failure.attempt === 1,
      ),
    ).toMatchObject({
      endpoint: "https://push2his.eastmoney.com/api/qt/stock/kline/get",
      attempt: 1,
      durationMs: expect.any(Number),
      detail: expect.stringContaining("UND_ERR_SOCKET"),
      error: { cause: { code: "UND_ERR_SOCKET" } },
    });
    expect(records()).toMatchObject([
      {
        status: "complete",
        snapshot: {
          diagnostics: {
            cacheHits: 0,
            cacheMisses: expect.any(Number),
            attempts: expect.arrayContaining([
              expect.objectContaining({
                id: "market.daily",
                provider: "tencent",
                attempt: 2,
                outcome: "success",
              }),
            ]),
          },
        },
      },
    ]);
    const final = progress.at(-1)!;
    expect(final.completed).toBe(final.total);
    expect(final.recordPath).toBe(result.recordPath);
  });

  it("stops after two unavailable daily rounds and persists all three sources without starting optional work", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(networkError());
    const { service, records } = setup(["eastmoney-market", "tencent", "sina"]);
    const progress: CollectionProgress[] = [];
    const result = await service.collect(scope, undefined, (value) =>
      progress.push(value),
    );
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(result.packets).toEqual([]);
    expect(
      result.failures
        .filter((failure) => failure.id === "market.daily")
        .map((failure) => [failure.provider, failure.attempt]),
    ).toEqual([
      ["eastmoney", 1],
      ["tencent", 1],
      ["sina", 1],
      ["eastmoney", 2],
      ["tencent", 2],
      ["sina", 2],
    ]);
    expect(records()).toMatchObject([
      {
        status: "missing_required",
        snapshot: { packets: [], diagnostics: { attempts: expect.any(Array) } },
      },
    ]);
    expect(() => requireCollectionData(result)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(result.recordPath!),
      }),
    );
    expect(
      progress
        .flatMap((value) => value.failures ?? [])
        .filter((failure) => failure.id === "market.daily"),
    ).toHaveLength(6);
  });

  it("bounds required daily recovery at 45 seconds", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          options!.signal!.addEventListener(
            "abort",
            () => reject(options!.signal!.reason),
            { once: true },
          );
        }),
    );
    const { service, records } = setup();
    const work = service.collect(scope);
    await started.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await work;
    expect(records()[0]!.status).toBe("missing_required");
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        id: "market.daily",
        code: "TimeoutError",
        detail: expect.stringContaining("45-second budget"),
      }),
    );
    expect(
      Date.parse(result.diagnostics!.finishedAt) -
        Date.parse(result.diagnostics!.startedAt),
    ).toBe(45_000);
  });

  it("lets different providers progress together while serializing one provider", async () => {
    const release = deferred<void>();
    const both = deferred<void>();
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const seen = new Set<string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const source = url.hostname.includes("gtimg") ? "tencent" : "sina";
      active.set(source, (active.get(source) ?? 0) + 1);
      maximum.set(
        source,
        Math.max(maximum.get(source) ?? 0, active.get(source)!),
      );
      seen.add(source);
      if (seen.size === 2) both.resolve();
      await release.promise;
      active.set(source, active.get(source)! - 1);
      return source === "tencent"
        ? tencentResponse(url)
        : new Response(JSON.stringify([{ day: "2026-10-28" }]));
    });
    const { service } = setup(["tencent", "sina"], false);
    const work = service.collect(scope);
    try {
      await both.promise;
      expect([...active.values()].reduce((sum, value) => sum + value, 0)).toBe(
        2,
      );
    } finally {
      release.resolve();
    }
    await work;
    expect(maximum).toEqual(
      new Map([
        ["tencent", 1],
        ["sina", 1],
      ]),
    );
  });

  it("still tries a deprioritized primary after its preferred standby fails", async () => {
    let second = false;
    let primaryDailyCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname.includes("gtimg")) {
        if (second && url.searchParams.get("param")?.includes(",day,"))
          throw networkError();
        return tencentResponse(url);
      }
      if (url.searchParams.get("klt") === "101") {
        primaryDailyCalls++;
        if (second)
          return new Response(
            JSON.stringify({
              rc: 0,
              data: {
                code: "600519",
                market: 1,
                klines: ["2026-10-28,100,102,103,99,10,102000,4,2,2,0.01"],
              },
            }),
          );
      }
      throw networkError();
    });
    const { service } = setup();
    await service.collect(scope);
    second = true;
    const result = await service.collect({
      ...scope,
      cutoff: "2026-10-28T10:01:00.000Z",
    });
    expect(
      result.packets.find((packet) => packet.id === "market.daily")!.envelope
        .source.provider,
    ).toBe("eastmoney");
    expect(primaryDailyCalls).toBe(2);
  });

  it("does not suppress unrelated Eastmoney endpoints when history is unavailable", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname.includes("gtimg")) return tencentResponse(url);
        throw networkError();
      });
    const { service } = setup();
    await service.collect(scope);
    const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
    expect(
      urls.filter((url) => url.hostname === "push2his.eastmoney.com"),
    ).toHaveLength(2);
    expect(urls.some((url) => url.pathname === "/api/qt/stock/get")).toBe(true);
    expect(
      urls.some((url) => url.hostname === "datacenter-web.eastmoney.com"),
    ).toBe(true);
  });

  it("revisits a primary deferred during queueing when its standby subsequently fails", async () => {
    let primaryMonthlyCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname.includes("gtimg")) {
        if (url.searchParams.get("param")?.includes(",month,"))
          throw networkError();
        return tencentResponse(url);
      }
      if (url.searchParams.get("klt") === "103") {
        primaryMonthlyCalls++;
        return new Response(
          JSON.stringify({
            rc: 0,
            data: {
              code: "600519",
              market: 1,
              klines: ["2026-09-30,100,102,103,99,10,102000,4,2,2,0.01"],
            },
          }),
        );
      }
      throw networkError();
    });
    const { service } = setup(["eastmoney-market", "tencent"], false);
    const result = await service.collect(scope);
    expect(primaryMonthlyCalls).toBe(1);
    expect(
      result.packets.find((packet) => packet.id === "market.monthly")!.envelope
        .source.provider,
    ).toBe("eastmoney");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ id: "market.monthly", provider: "tencent" }),
    );
  });

  it("publishes a failed record path before propagating the original unexpected error", async () => {
    const error = new Error("unexpected adapter failure");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const { service, records } = setup();
    const progress: CollectionProgress[] = [];
    await expect(
      service.collect(scope, undefined, (value) => progress.push(value)),
    ).rejects.toBe(error);
    expect(records()).toMatchObject([
      { status: "failed", error: { message: error.message } },
    ]);
    expect(fs.existsSync(progress.at(-1)!.recordPath!)).toBe(true);
  });

  it("preserves cancellation and does not discard a busy source queue when its last waiter cancels", async () => {
    const { service, query, records } = setup(["yahoo"], false);
    const firstStarted = deferred<void>();
    const release = deferred<void>();
    const us: ResearchScope = {
      ...scope,
      security: {
        id: "US:AAPL",
        market: "US",
        symbol: "AAPL",
        exchange: "NASDAQ",
        currency: "USD",
        timeZone: "America/New_York",
      },
    };
    query.mockImplementation(async (selected) => {
      if (selected.cutoff === us.cutoff) {
        firstStarted.resolve();
        await release.promise;
      }
      return {
        dataset: "market",
        data: {
          currency: "USD",
          adjustment: "split_adjusted",
          bars: [
            {
              date: "2026-10-27",
              asOf: "2026-10-27T20:00:00.000Z",
              availableAt: null,
              sessionComplete: true,
              open: 100,
              close: 102,
              high: 103,
              low: 99,
              volume: 10,
            },
          ],
        },
        source: {
          provider: "yahoo",
          url: "https://query1.finance.yahoo.com/",
          adapterVersion: "1",
          normalizationVersion: "1",
        },
        asOf: "2026-10-27T20:00:00.000Z",
        availableAt: null,
        retrievedAt: scope.cutoff,
        cutoff: selected.cutoff,
        ageMs: 0,
        stale: false,
        historicalKnowledge: "unverified",
        gaps: [],
      };
    });
    const first = service.collect(us);
    await firstStarted.promise;
    const controller = new AbortController();
    const secondScope = { ...us, cutoff: "2026-10-28T10:01:00.000Z" };
    const second = service.collect(secondScope, controller.signal);
    const reason = new Error("cancel queued research");
    const cancelled = expect(second).rejects.toBe(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await cancelled;
    await vi.waitFor(() =>
      expect(records().some((record) => record.status === "cancelled")).toBe(
        true,
      ),
    );
    const third = service.collect({
      ...us,
      cutoff: "2026-10-28T10:02:00.000Z",
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await Promise.all([first, third]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      records().find((record) => record.status === "cancelled")!.error,
    ).toMatchObject({ message: reason.message });
  });
});
