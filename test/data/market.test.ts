import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Security } from "../../src/contracts/data.js";
import type { MarketQuery } from "../../src/contracts/market.js";
import { EastmoneyMarketAdapter } from "../../src/data/eastmoney-market.js";
import { HttpClient } from "../../src/data/http.js";
import { TencentMarketAdapter } from "../../src/data/tencent-market.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/sources/${name}.json`, import.meta.url),
    "utf8",
  );
}

function query(
  security = CN_SECURITY,
  date = "2024-01-09",
  cutoff = "2024-01-09T22:00:00.000Z",
): MarketQuery {
  return {
    scope: { security, date, cutoff },
    startDate: "2024-01-02",
    maxAgeMs: 86_400_000,
  };
}

function setup(provider: "yahoo" | "eastmoney" | "tencent", name?: string) {
  const http = new HttpClient({
    timeoutMs: 1_000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi
    .spyOn(http, "getText")
    .mockResolvedValue(
      fixture(
        name ?? `${provider}-${provider === "yahoo" ? "nvda" : "600519"}`,
      ),
    );
  const adapter =
    provider === "yahoo"
      ? new YahooMarketAdapter(http)
      : provider === "eastmoney"
        ? new EastmoneyMarketAdapter(http)
        : new TencentMarketAdapter(http);
  return { adapter, get };
}

function tencent(rows: unknown[], symbol = "sh600519") {
  return JSON.stringify({
    code: 0,
    data: {
      [symbol]: {
        day: rows,
        qt: { unrelated: "current quote must be ignored" },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("daily market sources", () => {
  it("preserves Yahoo quote OHLCV rather than dividend-adjusted close", async () => {
    const { adapter } = setup("yahoo");
    const result = await adapter.query(query(US_SECURITY));
    expect(result.data.adjustment).toBe("split_adjusted");
    expect(result.data.bars[0]).toMatchObject({
      date: "2024-01-02",
      open: 49.24399948120117,
      high: 49.29499816894531,
      low: 47.595001220703125,
      close: 48.167999267578125,
      volume: 411254000,
    });
    expect(result.data.bars[0]!.close).not.toBe(48.028785705566406);
  });

  it.each(["eastmoney", "tencent"] as const)(
    "normalizes %s unadjusted prices and lots",
    async (provider) => {
      const { adapter } = setup(provider);
      const result = await adapter.query(query());
      expect(result.data.adjustment).toBe("unadjusted");
      expect(result.data.bars).toHaveLength(6);
      expect(result.data.bars[0]).toMatchObject({
        date: "2024-01-02",
        open: 1715,
        close: 1685.01,
        high: 1718.19,
        low: 1678.1,
        volume: 3215600,
      });
    },
  );

  it.each([
    ["000001", "SZ", 9.39, 9.21, 9.42, 9.21, 115836600],
    ["688001", "SH", 34.99, 34.72, 36.2, 34.43, 2640930],
  ] as const)(
    "uses the observed Tencent volume unit for %s",
    async (code, exchange, open, close, high, low, volume) => {
      const { adapter } = setup("tencent", `tencent-${code}`);
      const security: Security = {
        ...CN_SECURITY,
        id: `CN:${code}.${exchange}`,
        symbol: `${code}.${exchange}`,
        exchange,
      };
      const result = await adapter.query(query(security));
      expect(result.data.bars[0]).toMatchObject({
        open,
        close,
        high,
        low,
        volume,
      });
    },
  );

  it.each(["yahoo", "eastmoney", "tencent"] as const)(
    "records %s request provenance and passes cancellation",
    async (provider) => {
      const { adapter, get } = setup(provider);
      const signal = new AbortController().signal;
      const result = await adapter.query(
        query(provider === "yahoo" ? US_SECURITY : CN_SECURITY),
        signal,
      );
      const [requested, options] = get.mock.calls[0]!;
      const url = new URL(String(requested));
      expect(options?.signal).toBe(signal);
      expect(result.source.url).toBe(url.href);
      expect(result.source.provider).toBe(provider);
      if (provider === "yahoo") {
        expect(url.hostname).toBe("query1.finance.yahoo.com");
        expect(url.pathname).toBe("/v8/finance/chart/NVDA");
        expect(url.searchParams.get("interval")).toBe("1d");
        expect(url.searchParams.get("includeAdjustedClose")).toBe("false");
        expect(url.searchParams.has("events")).toBe(false);
        expect(url.searchParams.get("period1")).toBe("1704153600");
        expect(url.searchParams.get("period2")).toBe("1704844800");
      } else if (provider === "eastmoney") {
        expect(url.hostname).toBe("push2his.eastmoney.com");
        expect(url.searchParams.get("fqt")).toBe("0");
        expect(url.searchParams.get("secid")).toBe("1.600519");
        expect(url.searchParams.get("fields1")).toBe("f1,f2");
        expect(url.searchParams.get("fields2")).toBe("f51,f52,f53,f54,f55,f56");
        expect(url.searchParams.get("beg")).toBe("20240102");
        expect(url.searchParams.get("end")).toBe("20240109");
        expect(url.searchParams.get("lmt")).toBe("8");
      } else {
        expect(url.hostname).toBe("web.ifzq.gtimg.cn");
        expect(url.searchParams.get("param")).toBe(
          "sh600519,day,2024-01-02,2024-01-09,8,",
        );
      }
    },
  );

  it("reads Eastmoney rows with only the requested OHLCV columns", async () => {
    const { adapter, get } = setup("eastmoney");
    get.mockResolvedValue(
      JSON.stringify({
        rc: 0,
        data: {
          code: "600519",
          market: 1,
          klines: ["2024-01-02,1715.00,1685.01,1718.19,1678.10,32156"],
        },
      }),
    );
    const result = await adapter.query(query());
    expect(result.data.bars).toHaveLength(1);
    expect(result.data.bars[0]).toMatchObject({
      open: 1715,
      close: 1685.01,
      high: 1718.19,
      low: 1678.1,
      volume: 3215600,
    });
    get.mockResolvedValue(
      JSON.stringify({
        rc: 0,
        data: {
          code: "600519",
          market: 1,
          klines: ["2024-01-02,1715.00,1685.01"],
        },
      }),
    );
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("keeps historical knowledge unverified and session time separate from retrieval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T05:00:00Z"));
    const { adapter } = setup("eastmoney");
    const result = await adapter.query(query());
    expect(result).toMatchObject({
      historicalKnowledge: "unverified",
      availableAt: null,
      asOf: "2024-01-09T07:00:00.000Z",
      retrievedAt: "2026-10-25T05:00:00.000Z",
    });
    expect(
      result.data.bars.every(
        (bar) => bar.availableAt === null && bar.sessionComplete,
      ),
    ).toBe(true);
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unverified_time" }),
      ]),
    );
  });

  it("uses a strict greater-than stale threshold", async () => {
    const { adapter } = setup("eastmoney");
    const request = query(
      CN_SECURITY,
      "2024-01-10",
      "2024-01-10T07:00:00.000Z",
    );
    const fresh = await adapter.query({ ...request, maxAgeMs: 86400000 });
    const stale = await adapter.query({ ...request, maxAgeMs: 86399999 });
    expect(fresh).toMatchObject({ ageMs: 86400000, stale: false });
    expect(stale.stale).toBe(true);
    expect(stale.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale" })]),
    );
  });

  it("keeps a Friday close fresh on Monday before completion without truncating history", async () => {
    const { adapter, get } = setup("tencent");
    get.mockResolvedValue(
      tencent([
        ["2026-10-22", "79", "80", "81", "78", "100"],
        ["2026-10-23", "80", "81", "82", "79", "120"],
      ]),
    );
    const result = await adapter.query({
      scope: {
        security: CN_SECURITY,
        date: "2026-10-26",
        cutoff: "2026-10-26T05:00:00.000Z",
      },
      startDate: "2026-08-28",
      maxAgeMs: 86400000,
    });
    expect(result.ageMs).toBe(250200000);
    expect(result.stale).toBe(false);
    expect(result.gaps.some((gap) => gap.code === "stale")).toBe(false);
    expect(result.data.bars.map((bar) => bar.date)).toEqual([
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(result.source.normalizationVersion).toBe("2");
    expect(get).toHaveBeenCalledOnce();
  });

  it.each(["yahoo", "eastmoney", "tencent"] as const)(
    "preserves %s network failure identity",
    async (provider) => {
      const { adapter, get } = setup(provider);
      const cause = new Error("connection failed");
      get.mockRejectedValue(cause);
      await expect(
        adapter.query(query(provider === "yahoo" ? US_SECURITY : CN_SECURITY)),
      ).rejects.toBe(cause);
    },
  );

  it.each(["{", "null", "[]"])(
    "rejects invalid source JSON shape %s",
    async (text) => {
      const { adapter, get } = setup("tencent");
      get.mockResolvedValue(text);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
    },
  );

  it.each([
    ["yahoo", { chart: { error: { code: "Not Found" }, result: null } }],
    ["eastmoney", { rc: 1, data: null }],
    ["tencent", { code: 1, msg: "failed", data: {} }],
  ] as const)(
    "surfaces %s service errors with their cause",
    async (provider, payload) => {
      const { adapter, get } = setup(provider);
      get.mockResolvedValue(JSON.stringify(payload));
      await expect(
        adapter.query(query(provider === "yahoo" ? US_SECURITY : CN_SECURITY)),
      ).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
        cause: "chart" in payload ? payload.chart.error : payload,
      });
    },
  );

  it("keeps missing Yahoo columns null instead of manufacturing zero", async () => {
    const { adapter, get } = setup("yahoo");
    const payload = JSON.parse(fixture("yahoo-nvda"));
    delete payload.chart.result[0].indicators.quote[0].volume;
    payload.chart.result[0].indicators.quote[0].open[0] = null;
    get.mockResolvedValue(JSON.stringify(payload));
    const result = await adapter.query(query(US_SECURITY));
    expect(result.data.bars[0]).toMatchObject({ open: null, volume: null });
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing",
          field: "/data/bars/0/open",
        }),
        expect.objectContaining({
          code: "missing",
          field: "/data/bars/0/volume",
        }),
      ]),
    );
  });

  it("keeps Tencent null values missing and accepts a corporate-action suffix", async () => {
    const { adapter, get } = setup("tencent");
    get.mockResolvedValue(
      tencent([
        ["2024-01-02", null, "10", "11", "9", "-", { dividend: "event" }],
      ]),
    );
    const result = await adapter.query(query());
    expect(result.data.bars[0]).toMatchObject({
      open: null,
      close: 10,
      volume: null,
    });
    expect(result.gaps.filter((gap) => gap.code === "missing")).toHaveLength(2);
  });

  it.each([
    ["2024-01-02", "12", "10", "11", "9", "1"],
    ["2024-01-02", "10", "10", "9", "11", "1"],
    ["2024-01-02", "10", "10", "11", "9"],
    ["2024-01-02", "NaN", "10", "11", "9", "1"],
    ["2024-01-02", "8", "9", null, "10", "1"],
    ["2024-01-02", "12", "10", "11", null, "1"],
  ])(
    "rejects contradictory prices or invalid columns without guessing repairs",
    async (...row) => {
      const { adapter, get } = setup("tencent");
      get.mockResolvedValue(tencent([row]));
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
    },
  );

  it("sorts source dates and rejects duplicate daily rows", async () => {
    const { adapter, get } = setup("tencent");
    const first = ["2024-01-02", "10", "10", "11", "9", "1"];
    const second = ["2024-01-03", "10", "10", "11", "9", "2"];
    get.mockResolvedValue(tencent([second, first]));
    expect(
      (await adapter.query(query())).data.bars.map((bar) => bar.date),
    ).toEqual(["2024-01-02", "2024-01-03"]);
    get.mockResolvedValue(tencent([first, first]));
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("rejects adjusted-only Tencent data instead of substituting it", async () => {
    const { adapter, get } = setup("tencent");
    get.mockResolvedValue(
      JSON.stringify({ code: 0, data: { sh600519: { qfqday: [] } } }),
    );
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("reports an empty requested interval", async () => {
    const { adapter } = setup("eastmoney");
    await expect(
      adapter.query({
        ...query(),
        startDate: "2024-01-10",
        scope: { ...query().scope, date: "2024-01-11" },
      }),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });

  it.each(["2023-12-29", "2027-01-04"])(
    "rejects dates outside verified session coverage: %s",
    async (date) => {
      const { adapter, get } = setup("yahoo");
      await expect(
        adapter.query({ ...query(US_SECURITY, date), startDate: date }),
      ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("declares exchange scope and rejects unsupported exchanges", async () => {
    const { adapter, get } = setup("yahoo");
    expect(adapter.capability).toMatchObject({
      exchanges: ["NASDAQ", "NYSE"],
      dates: { start: "2024-01-01", end: "2026-12-31" },
      historicalVersions: false,
    });
    await expect(
      adapter.query(query({ ...US_SECURITY, exchange: "OTC" })),
    ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("completed daily session boundaries", () => {
  it.each([
    ["2024-01-02", "2024-01-02T14:30:00Z", "2024-01-02T21:00:00.000Z"],
    ["2024-07-02", "2024-07-02T13:30:00Z", "2024-07-02T20:00:00.000Z"],
    ["2024-07-03", "2024-07-03T13:30:00Z", "2024-07-03T17:00:00.000Z"],
    ["2024-11-29", "2024-11-29T14:30:00Z", "2024-11-29T18:00:00.000Z"],
  ])(
    "uses the exchange closing instant on %s",
    async (date, opening, closing) => {
      const { adapter, get } = setup("yahoo");
      const payload = JSON.parse(fixture("yahoo-nvda"));
      payload.chart.result[0].timestamp = [Date.parse(opening) / 1000];
      const quote = payload.chart.result[0].indicators.quote[0];
      for (const field of Object.keys(quote)) quote[field] = [quote[field][0]];
      get.mockResolvedValue(JSON.stringify(payload));
      const request = { ...query(US_SECURITY, date, closing), startDate: date };
      await expect(
        adapter.query({
          ...request,
          scope: {
            ...request.scope,
            cutoff: new Date(Date.parse(closing) - 1).toISOString(),
          },
        }),
      ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
      expect((await adapter.query(request)).asOf).toBe(closing);
    },
  );

  it("excludes an unfinished China session at lunch", async () => {
    const { adapter } = setup("eastmoney");
    await expect(
      adapter.query(query(CN_SECURITY, "2024-01-02", "2024-01-02T04:00:00Z")),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });

  it.each([
    ["2026-07-03", "600519.SH", "SH", "07:00"],
    ["2026-07-06", "600519.SH", "SH", "07:30"],
    ["2024-01-02", "688001.SH", "SH", "07:30"],
    ["2024-01-02", "300750.SZ", "SZ", "07:30"],
  ])("waits until %s %s session ends", async (date, symbol, exchange, time) => {
    const { adapter, get } = setup("tencent");
    const security = { ...CN_SECURITY, symbol, exchange };
    get.mockResolvedValue(
      tencent(
        [[date, "10", "10", "11", "9", "1"]],
        exchange.toLowerCase() + symbol.slice(0, 6),
      ),
    );
    const closing = `${date}T${time}:00.000Z`;
    const request = { ...query(security, date, closing), startDate: date };
    await expect(
      adapter.query({
        ...request,
        scope: {
          ...request.scope,
          cutoff: new Date(Date.parse(closing) - 1).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    expect((await adapter.query(request)).asOf).toBe(closing);
  });
});
