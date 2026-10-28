import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import { HttpClient } from "../../src/data/http.js";
import { CollectionService } from "../../src/services/collection.js";
import type { QueryService } from "../../src/services/query.js";
import type { CollectionProgress } from "../../src/contracts/collection.js";
import { CN_SECURITY } from "../fixtures/market.js";
import { deferred } from "../fixtures/runtime-host.js";

const scope = {
  security: CN_SECURITY,
  date: "2024-01-03",
  cutoff: "2024-01-03T08:00:00.000Z",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
function setup(
  enabledSources = ["eastmoney-market", "tencent"],
  macroTtl = 0,
  macroBudget = 0,
) {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-test-"));
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 100,
  });
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const query = vi.fn() as QueryService["query"];
  const service = new CollectionService(
    http,
    cache,
    { query },
    {
      enabledSources,
      freshness: { market: 86400000, fundamentals: 0, macro: macroBudget },
      secCiks: {},
      ttl: { market: 60000, fundamentals: 60000, macro: macroTtl, research: 0 },
    },
  );
  cleanups.push(async () => {
    await service.close();
    await http.close();
    cache.close();
    fs.rmSync(directory, { recursive: true });
  });
  return { service, query, cache, http };
}
function response(primarySucceeds: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "web.ifzq.gtimg.cn")
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            sh600519: {
              day: [["2024-01-03", "100", "102", "103", "99", "10"]],
            },
          },
        }),
      );
    if (
      primarySucceeds &&
      url.pathname.includes("kline") &&
      url.searchParams.get("klt") === "101"
    )
      return new Response(
        JSON.stringify({
          rc: 0,
          data: {
            code: "600519",
            market: 1,
            klines: ["2024-01-03,100,102,103,99,10,102000,4,2,2,0.01"],
          },
        }),
      );
    return new Response(
      JSON.stringify({
        rc: 1,
        success: false,
        code: 1,
        message: "fixture source unavailable",
      }),
    );
  });
}

function isTencentDaily(input: unknown): boolean {
  const url = new URL(String(input));
  return (
    url.hostname === "web.ifzq.gtimg.cn" &&
    url.searchParams.get("param")?.split(",")[1] === "day"
  );
}

describe("deterministic collection orchestration", () => {
  it.each([
    ["eastmoney-market", "tencent", "sina"],
    ["eastmoney-market", "sina"],
    ["sina"],
  ])(
    "uses the enabled Sina tail and reuses its cache: %j",
    async (...sources) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (
            url.hostname === "money.finance.sina.com.cn" &&
            url.searchParams.get("ma") === "no"
          ) {
            const date =
              url.searchParams.get("scale") === "240"
                ? "2024-01-03"
                : "2023-12-29";
            return new Response(
              JSON.stringify([
                {
                  day: date,
                  open: "100",
                  high: "103",
                  low: "99",
                  close: "102",
                  volume: "1000",
                },
              ]),
            );
          }
          return new Response("unavailable", { status: 503 });
        });
      const { service } = setup(sources);
      const first = await service.collect(scope);
      const bars = first.packets.filter(({ id }) =>
        ["market.daily", "market.weekly", "market.monthly"].includes(id),
      );
      expect(bars.map(({ id }) => id)).toEqual([
        "market.daily",
        "market.weekly",
        "market.monthly",
      ]);
      expect(
        bars.every(({ envelope }) => envelope.source.provider === "sina"),
      ).toBe(true);
      expect(bars[0]!.envelope.data.rows[0]!.values.volume).toBe(1000);
      expect(first.packets.some(({ id }) => id.startsWith("benchmark."))).toBe(
        false,
      );
      const historyCalls = () =>
        fetch.mock.calls.filter(([input]) => {
          const url = new URL(String(input));
          return (
            url.searchParams.has("klt") ||
            url.searchParams.has("param") ||
            url.searchParams.get("ma") === "no"
          );
        });
      const before = historyCalls().length;
      const cached = await service.collect(scope);
      expect(historyCalls()).toHaveLength(before);
      expect(cached.diagnostics!.cacheHits).toBe(3);
      expect(
        cached.packets
          .filter(({ id }) => id.startsWith("market."))
          .map(({ envelope }) => envelope.source.provider),
      ).toEqual(["sina", "sina", "sina"]);
      if (!sources.includes("tencent"))
        expect(
          fetch.mock.calls.some(([input]) =>
            new URL(String(input)).hostname.includes("gtimg"),
          ),
        ).toBe(false);
    },
  );

  it("shares live progress with late subscribers and detaches a cancelled observer", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const fetch = response(true);
    const respond = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return respond(...args);
    });
    const { service } = setup(["tencent"]);
    const first: CollectionProgress[] = [];
    const second: CollectionProgress[] = [];
    const controller = new AbortController();
    const firstWork = service.collect(scope, controller.signal, (progress) =>
      first.push(progress),
    );
    const cancelled = expect(firstWork).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    expect(first).toEqual([
      {
        total: 3,
        completed: 0,
        succeeded: 0,
        failed: 0,
        cacheHits: 0,
        cacheMisses: 3,
        current: { id: "market.daily", provider: "tencent" },
      },
    ]);
    const secondWork = service.collect(scope, undefined, (progress) =>
      second.push(progress),
    );
    expect(second).toEqual(first);
    controller.abort();
    await cancelled;
    release.resolve();
    const result = await secondWork;
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.packets).toHaveLength(1);
    expect(first).toHaveLength(1);
    expect(second.at(-1)).toEqual({
      total: 3,
      completed: 3,
      succeeded: 1,
      failed: 2,
      cacheHits: 0,
      cacheMisses: 3,
      failures: [
        expect.objectContaining({
          id: "market.monthly",
          provider: "tencent",
          code: "SOURCE_UNAVAILABLE",
        }),
      ],
    });
    expect(
      result.failures
        .filter((failure) => failure.provider === "tencent")
        .map(({ id, provider, code }) => ({ id, provider, code })),
    ).toEqual([
      { id: "market.weekly", provider: "tencent", code: "SOURCE_UNAVAILABLE" },
      { id: "market.monthly", provider: "tencent", code: "SOURCE_UNAVAILABLE" },
    ]);
  });

  it("reports fallback work and counts a successful fallback once", async () => {
    response(false);
    const { service } = setup();
    const progress: CollectionProgress[] = [];
    const result = await service.collect(scope, undefined, (value) =>
      progress.push(value),
    );
    expect(
      progress
        .filter((value) => value.current?.id === "market.daily")
        .map((value) => value.current?.provider),
    ).toEqual(["eastmoney", "tencent"]);
    expect(
      progress.find((value) =>
        value.failures?.some((failure) => failure.id === "market.daily"),
      ),
    ).toMatchObject({
      completed: 1,
      succeeded: 1,
      failed: 0,
      failures: [
        expect.objectContaining({
          id: "market.daily",
          provider: "eastmoney",
          code: "SOURCE_UNAVAILABLE",
        }),
      ],
    });
    const final = progress.at(-1)!;
    expect(final.completed).toBe(final.total);
    expect(final.succeeded).toBe(1);
    expect(final.failed).toBe(final.total - 1);
    expect(result.packets.map((packet) => packet.id)).toEqual(["market.daily"]);
  });

  it("does not reuse freshness metadata cached under a different configured budget", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            code: 0,
            result: {
              data: [
                {
                  SECUCODE: CN_SECURITY.symbol,
                  REPORT_DATE: "2023-12-31 00:00:00",
                  NOTICE_DATE: "2024-01-02 00:00:00",
                  CURRENCY: "CNY",
                  EPSJB: 1,
                },
              ],
            },
          }),
        ),
    );
    const first = setup(["eastmoney-income"]);
    const strict = await first.service.collect(scope);
    expect(
      strict.packets.find((packet) => packet.id === "financial.indicators")!
        .envelope.stale,
    ).toBe(true);
    const relaxed = new CollectionService(
      first.http,
      first.cache,
      { query: first.query },
      {
        enabledSources: ["eastmoney-income"],
        freshness: { market: 86400000, fundamentals: 200 * 86400000, macro: 0 },
        secCiks: {},
        ttl: { market: 60000, fundamentals: 60000, macro: 0, research: 0 },
      },
    );
    try {
      const result = await relaxed.collect(scope);
      expect(
        result.packets.find((packet) => packet.id === "financial.indicators")!
          .envelope.stale,
      ).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(10);
    } finally {
      await relaxed.close();
    }
  });

  it("finalizes every envelope to the analysis cutoff without rewriting the cached capture", async () => {
    response(true);
    const { service } = setup(["eastmoney-market"]);
    const snapshot = await service.collect(scope);
    const finalScope = { ...scope, cutoff: "2024-01-03T08:00:30.000Z" };
    service.finalizeScope(snapshot, finalScope);
    expect(snapshot.scope).toEqual(finalScope);
    expect(
      snapshot.packets.every(
        (packet) => packet.envelope.cutoff === finalScope.cutoff,
      ),
    ).toBe(true);
    expect(snapshot.packets[0]!.envelope.ageMs).toBe(3630000);
    const original = await service.collect(scope);
    expect(original.packets[0]!.envelope.cutoff).toBe(scope.cutoff);
  });
  it("keeps a single primary daily series and never calls its standby after success", async () => {
    const fetch = response(true);
    const { service, query } = setup();
    const result = await service.collect(scope);
    const daily = result.packets.filter(
      (packet) => packet.id === "market.daily",
    );
    expect(daily).toHaveLength(1);
    expect(daily[0]!.envelope.source.provider).toBe("eastmoney");
    expect(daily[0]!.envelope.data.rows[0]!.values).toMatchObject({
      close: 102,
      volume: 1000,
      amount: 102000,
    });
    expect(fetch.mock.calls.some(([url]) => isTencentDaily(url))).toBe(false);
    expect(
      fetch.mock.calls.some(([url]) => /search|news|fred/.test(String(url))),
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the configured daily standby only after primary failure and retains that failure", async () => {
    const fetch = response(false);
    const { service } = setup();
    const result = await service.collect(scope);
    expect(
      result.packets.filter((packet) => packet.id === "market.daily"),
    ).toHaveLength(1);
    const daily = result.packets.find(
      (packet) => packet.id === "market.daily",
    )!;
    expect(daily.envelope.source.provider).toBe("tencent");
    expect(daily.envelope.data.rows[0]!.values.close).toBe(102);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        id: "market.daily",
        provider: "eastmoney",
        code: "SOURCE_UNAVAILABLE",
      }),
    );
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(1);
  });

  it("does not call a disabled standby and reports unavailable datasets explicitly", async () => {
    const fetch = response(false);
    const { service } = setup(["eastmoney-market"]);
    const result = await service.collect(scope);
    expect(result.packets).toEqual([]);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ id: "macro.gdp", code: "SOURCE_UNAVAILABLE" }),
    );
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("gtimg")),
    ).toBe(false);
  });

  it("reuses a cached daily standby without retrying its failed primary", async () => {
    const fetch = response(false);
    const { service } = setup();
    const first = await service.collect(scope);
    const dailyCalls = () =>
      fetch.mock.calls
        .filter(([input]) => {
          const url = new URL(String(input));
          return (
            isTencentDaily(input) ||
            (url.pathname.includes("kline") &&
              url.searchParams.get("klt") === "101")
          );
        })
        .map(([input]) => String(input));
    const initialDailyCalls = dailyCalls();
    expect(initialDailyCalls).toHaveLength(2);
    const progress: CollectionProgress[] = [];
    const second = await service.collect(scope, undefined, (value) =>
      progress.push(value),
    );
    expect(dailyCalls()).toEqual(initialDailyCalls);
    const daily = (snapshot: typeof first) =>
      snapshot.packets.find((packet) => packet.id === "market.daily")!;
    expect(daily(second)).toEqual(daily(first));
    expect(daily(second).envelope.source.provider).toBe("tencent");
    expect(progress.at(-1)!.cacheHits).toBe(1);
    expect(
      second.failures.filter((failure) => failure.id === "market.daily"),
    ).toEqual([]);
  });

  it("shares a concurrent capture and reuses a successful cached dataset without replacing its timestamp", async () => {
    const fetch = response(true);
    const { service } = setup(["eastmoney-market"]);
    const [first, second] = await Promise.all([
      service.collect(scope),
      service.collect(scope),
    ]);
    expect(second).toEqual(first);
    const third = await service.collect(scope);
    expect(third.packets).toEqual(first.packets);
    expect(
      fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).searchParams.get("klt") === "101",
      ),
    ).toHaveLength(1);
    first.packets[0]!.envelope.data.rows[0]!.values.close = 999;
    expect(second.packets[0]!.envelope.data.rows[0]!.values.close).toBe(102);
  });

  it("reuses a completed daily table in the same time segment and reports cache hits", async () => {
    const fetch = response(true);
    const { service } = setup(["tencent"]);
    const first = await service.collect(scope);
    const later = { ...scope, cutoff: "2024-01-03T08:30:00.000Z" };
    const progress: CollectionProgress[] = [];
    const second = await service.collect(later, undefined, (value) =>
      progress.push(value),
    );
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(1);
    expect(second.packets[0]!.envelope).toMatchObject({
      cutoff: later.cutoff,
      retrievedAt: first.packets[0]!.envelope.retrievedAt,
      ageMs:
        Date.parse(later.cutoff) - Date.parse(first.packets[0]!.envelope.asOf),
    });
    expect(progress.at(-1)).toMatchObject({ cacheHits: 1, cacheMisses: 2 });
  });

  it("does not reuse a later cutoff for an earlier request in the same segment", async () => {
    const fetch = response(true);
    const { service } = setup(["tencent"]);
    await service.collect({ ...scope, cutoff: "2024-01-03T08:30:00.000Z" });
    await service.collect(scope);
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(2);
  });

  it("does not reuse a table across the market close boundary", async () => {
    const fetch = response(true);
    const { service } = setup(["tencent"]);
    const before = await service.collect({
      ...scope,
      cutoff: "2024-01-03T06:59:00.000Z",
    });
    const after = await service.collect({
      ...scope,
      cutoff: "2024-01-03T07:01:00.000Z",
    });
    expect(before.packets).toHaveLength(0);
    expect(after.packets).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(2);
  });

  it("does not reuse a table across the 15:30 A-share close", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              sh600519: {
                day: [["2026-10-28", "100", "102", "103", "99", "10"]],
              },
            },
          }),
        ),
    );
    const { service } = setup(["tencent"]);
    const dateScope = { ...scope, date: "2026-10-28" };
    const before = await service.collect({
      ...dateScope,
      cutoff: "2026-10-28T07:29:59.999Z",
    });
    const after = await service.collect({
      ...dateScope,
      cutoff: "2026-10-28T07:30:00.000Z",
    });
    expect(before.packets).toHaveLength(0);
    expect(after.packets).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(2);
  });

  it("shares macro tables across stocks while reporting the hit separately", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              pages: 1,
              data: [{ REPORT_DATE: "2023-12-01", NATIONAL_SAME: 101 }],
            },
          }),
        ),
    );
    const { service } = setup(["china-macro"], 60000);
    const first = await service.collect(scope);
    const later = {
      ...scope,
      security: { ...scope.security, id: "CN:600000.SH", symbol: "600000.SH" },
      cutoff: "2024-01-03T08:01:00.000Z",
    };
    const progress: CollectionProgress[] = [];
    const second = await service.collect(later, undefined, (value) =>
      progress.push(value),
    );
    const cpi = (url: unknown) =>
      new URL(String(url)).searchParams.get("reportName") === "RPT_ECONOMY_CPI";
    expect(first.packets.some((packet) => packet.id === "macro.cpi")).toBe(
      true,
    );
    expect(second.packets.some((packet) => packet.id === "macro.cpi")).toBe(
      true,
    );
    expect(fetch.mock.calls.filter(([url]) => cpi(url))).toHaveLength(1);
    expect(progress.at(-1)!.cacheHits).toBeGreaterThan(0);
  });

  it("recomputes freshness for each consumer of a cached table", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              pages: 1,
              data: [
                {
                  REPORT_DATE: "2023-12-01",
                  TRADE_DATE: "2024-01-03",
                  LPR1Y: 3.45,
                },
              ],
            },
          }),
        ),
    );
    const { service } = setup(["china-macro"], 60000, 8.5 * 60 * 60 * 1000);
    const first = await service.collect(scope);
    const second = await service.collect({
      ...scope,
      cutoff: "2024-01-03T08:45:00.000Z",
    });
    expect(
      first.packets.find((packet) => packet.id === "macro.lpr")!.envelope.stale,
    ).toBe(false);
    expect(
      second.packets.find((packet) => packet.id === "macro.lpr")!.envelope
        .stale,
    ).toBe(true);
    expect(
      fetch.mock.calls.filter(
        ([url]) =>
          new URL(String(url)).searchParams.get("reportName") ===
          "RPTA_WEB_RATE",
      ),
    ).toHaveLength(1);
  });

  it("does not reuse a monthly table across the completed-month boundary", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              pages: 1,
              data: [
                { REPORT_DATE: "2026-09-01", NATIONAL_SAME: 100 },
                { REPORT_DATE: "2026-10-01", NATIONAL_SAME: 101 },
              ],
            },
          }),
        ),
    );
    const { service } = setup(["china-macro"], 60000);
    const monthlyScope = { ...scope, date: "2026-10-31" };
    const before = await service.collect({
      ...monthlyScope,
      cutoff: "2026-10-31T15:59:59.998Z",
    });
    const after = await service.collect({
      ...monthlyScope,
      cutoff: "2026-10-31T15:59:59.999Z",
    });
    const rows = (snapshot: typeof before) =>
      snapshot.packets.find((packet) => packet.id === "macro.cpi")!.envelope
        .data.rows;
    expect(rows(before).map((row) => row.date)).toEqual(["2026-09-01"]);
    expect(rows(after).map((row) => row.date)).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(
      fetch.mock.calls.filter(
        ([url]) =>
          new URL(String(url)).searchParams.get("reportName") ===
          "RPT_ECONOMY_CPI",
      ),
    ).toHaveLength(2);
  });

  it("does not reuse a global benchmark across its UTC close", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "query1.finance.yahoo.com") {
          const interval = url.searchParams.get("interval");
          return new Response(
            JSON.stringify({
              chart: {
                error: null,
                result: [
                  {
                    meta: {
                      symbol: "CNY=X",
                      currency: "CNY",
                      instrumentType: "CURRENCY",
                      dataGranularity: interval,
                      exchangeTimezoneName: "Europe/London",
                    },
                    timestamp: [
                      Date.parse("2026-10-27T12:00:00Z") / 1000,
                      Date.parse("2026-10-28T12:00:00Z") / 1000,
                    ],
                    indicators: { quote: [{ close: [7, 7.1] }] },
                  },
                ],
              },
            }),
          );
        }
        return new Response(JSON.stringify({ rc: 1, success: false, code: 1 }));
      });
    const { service } = setup(["benchmarks"]);
    const benchmarkScope = { ...scope, date: "2026-10-28" };
    const before = await service.collect({
      ...benchmarkScope,
      cutoff: "2026-10-28T23:59:59.998Z",
    });
    const after = await service.collect({
      ...benchmarkScope,
      cutoff: "2026-10-28T23:59:59.999Z",
    });
    const rows = (snapshot: typeof before) =>
      snapshot.packets.find((packet) => packet.id === "benchmark.usdcny.daily")!
        .envelope.data.rows;
    expect(rows(before).map((row) => row.date)).toEqual(["2026-10-27"]);
    expect(rows(after).map((row) => row.date)).toEqual([
      "2026-10-27",
      "2026-10-28",
    ]);
    expect(
      fetch.mock.calls.filter(([url]) => {
        const target = new URL(String(url));
        return (
          target.hostname === "query1.finance.yahoo.com" &&
          target.searchParams.get("interval") === "1d"
        );
      }),
    ).toHaveLength(2);
  });

  it("retains source-stale warnings when a shared table is reused", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).includes("shrzgmQuery"))
          return new Response(
            JSON.stringify([{ date: "202604", tiosfs: 6245 }]),
          );
        return new Response(JSON.stringify({ success: false }));
      });
    const { service } = setup(["china-macro"], 60000, 365 * 86400000);
    const oldScope = {
      ...scope,
      date: "2026-10-28",
      cutoff: "2026-10-28T08:00:00.000Z",
    };
    const first = await service.collect(oldScope);
    const second = await service.collect({
      ...oldScope,
      cutoff: "2026-10-28T08:01:00.000Z",
    });
    const social = (snapshot: typeof first) =>
      snapshot.packets.find((packet) => packet.id === "macro.socialFinancing")!
        .envelope;
    expect(social(first).stale).toBe(true);
    expect(social(second).stale).toBe(true);
    expect(social(second).gaps).toContainEqual(
      expect.objectContaining({
        code: "stale",
        detail: expect.stringContaining(
          "source's latest social financing period",
        ),
      }),
    );
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("shrzgmQuery")),
    ).toHaveLength(1);
  });

  it("does not share stock-specific daily tables across securities", async () => {
    const fetch = response(true);
    const { service } = setup(["tencent"]);
    await service.collect(scope);
    await service.collect({
      ...scope,
      security: { ...scope.security, id: "CN:600000.SH", symbol: "600000.SH" },
      cutoff: "2024-01-03T08:01:00.000Z",
    });
    expect(
      fetch.mock.calls.filter(([url]) => isTencentDaily(url)),
    ).toHaveLength(2);
  });

  it("does not reuse live quote snapshots across different cutoffs", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/qt/stock/get")
          return new Response(
            JSON.stringify({
              rc: 0,
              data: {
                f57: "600519",
                f58: "测试",
                f59: 2,
                f152: 2,
                f86: Date.parse("2024-01-03T07:00:00Z") / 1000,
                f43: 10000,
              },
            }),
          );
        return new Response(JSON.stringify({ rc: 1, success: false, code: 1 }));
      });
    const { service } = setup(["eastmoney-market"]);
    const first = await service.collect(scope);
    const second = await service.collect({
      ...scope,
      cutoff: "2024-01-03T08:01:00.000Z",
    });
    expect(first.packets.some((packet) => packet.id === "stock.snapshot")).toBe(
      true,
    );
    expect(
      second.packets.some((packet) => packet.id === "stock.snapshot"),
    ).toBe(true);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).includes("/api/qt/stock/get"),
      ),
    ).toHaveLength(2);
  });

  it("does not start external requests after cancellation", async () => {
    const fetch = response(true);
    const { service } = setup();
    const controller = new AbortController();
    const reason = new Error("cancel collection");
    controller.abort(reason);
    await expect(service.collect(scope, controller.signal)).rejects.toBe(
      reason,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
