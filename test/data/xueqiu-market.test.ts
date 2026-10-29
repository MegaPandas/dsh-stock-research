import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createChinaMarketTasks } from "../../src/data/collection-market.js";
import { HttpClient } from "../../src/data/http.js";
import { XueqiuClient } from "../../src/data/xueqiu.js";

const scope: ResearchScope = {
  security: {
    id: "CN:002594.SZ",
    market: "CN",
    symbol: "002594.SZ",
    exchange: "SZ",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2026-10-27",
  cutoff: "2026-10-27T10:00:00.000Z",
};
const columns = [
  "close",
  "timestamp",
  "volume",
  "open",
  "high",
  "low",
  "amount",
  "percent",
  "chg",
  "turnoverrate",
];
function bar(date: string): unknown[] {
  return [
    82,
    Date.parse(`${date}T09:30:00+08:00`),
    12345,
    80,
    83,
    79,
    1000000,
    2.5,
    2,
    0.8,
  ];
}
function klines(dates = ["2026-10-26"]) {
  return { symbol: "SZ002594", column: columns, item: dates.map(bar) };
}
function quote(extra: Record<string, unknown> = {}) {
  return {
    quote: {
      symbol: "SZ002594",
      currency: "CNY",
      name: "比亚迪",
      timestamp: Date.parse("2026-10-26T07:34:15.000Z"),
      current: 82,
      volume: 12345,
      amount: 1000000,
      volume_ratio: 1.2,
      pe_lyr: 20,
      pe_ttm: 21,
      pe_forecast: 25,
      pb: 3,
      turnover_rate: 0.8,
      total_shares: 100000000,
      float_shares: 50000000,
      market_capital: 8200000000,
      float_market_capital: 4100000000,
      ...extra,
    },
  };
}
function setup(data: unknown, selectedScope = scope) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi
    .spyOn(http, "getText")
    .mockResolvedValue(JSON.stringify({ error_code: 0, data }));
  const client = new XueqiuClient(http, "session=fixture");
  return { get, tasks: createChinaMarketTasks(http, selectedScope, client) };
}
afterEach(() => vi.restoreAllMocks());

describe("Xueqiu China market fallback", () => {
  it("appends to the existing period sources and only requests data when run", () => {
    const { tasks, get } = setup({});
    for (const id of ["market.daily", "market.weekly", "market.monthly"]) {
      expect(
        tasks.filter((task) => task.id === id).map((task) => task.provider),
      ).toEqual(["eastmoney", "tencent", "sina", "xueqiu"]);
    }
    expect(
      tasks
        .filter((task) => task.id === "stock.snapshot")
        .map((task) => task.provider),
    ).toEqual(["eastmoney", "xueqiu"]);
    for (const id of ["market.averages", "valuation.history"])
      expect(tasks.filter((task) => task.id === id)).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("decodes source column names, keeps shares and percentages, and records absent amplitude", async () => {
    const { tasks, get } = setup(klines());
    const result = await tasks
      .filter((task) => task.provider === "xueqiu")[0]!
      .run();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: "SZ002594",
      begin: String(Date.parse("2026-10-27T07:30:00.000Z")),
      period: "day",
      type: "normal",
      count: "-60",
      indicator: "kline",
    });
    expect(result.source.provider).toBe("xueqiu");
    expect(result.data.adjustment).toBe("unadjusted");
    expect(result.data.columns.volume!.unit).toBe("shares");
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-10-26",
      asOf: "2026-10-26T07:30:00.000Z",
      complete: true,
      values: {
        open: 80,
        close: 82,
        high: 83,
        low: 79,
        volume: 12345,
        amount: 1000000,
        amplitude: null,
        changePercent: 2.5,
        change: 2,
        turnover: 0.8,
      },
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/rows/0/values/amplitude",
      }),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ code: "missing", field: "/data/rows" }),
    );
    expect(JSON.stringify(result)).not.toContain("session=fixture");
  });

  it.each([
    [0, "day", "-60", "2026-10-26", "2026-10-27", "2026-10-26T07:30:00.000Z"],
    [1, "week", "-52", "2026-10-19", "2026-10-26", "2026-10-23T07:30:00.000Z"],
    [2, "month", "-36", "2026-09-01", "2026-10-01", "2026-09-30T07:30:00.000Z"],
  ] as const)(
    "filters unfinished %s periods",
    async (index, period, count, completed, unfinished, asOf) => {
      const selectedScope = { ...scope, cutoff: "2026-10-27T06:00:00.000Z" };
      const { tasks, get } = setup(
        klines([completed, unfinished]),
        selectedScope,
      );
      const result = await tasks
        .filter((task) => task.provider === "xueqiu")
        .at(index)!
        .run();
      const url = new URL(String(get.mock.calls[0]![0]));
      expect(url.searchParams.get("period")).toBe(period);
      expect(url.searchParams.get("count")).toBe(count);
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0]).toMatchObject({ date: completed, asOf });
    },
  );

  it.each([
    { symbol: "SH600519" },
    { column: ["timestamp", "close", "close"] },
    { column: ["close", "open", "high", "low", "volume"] },
    { item: [[82]] },
    { item: ["bad row"] },
    {
      item: [
        [
          90,
          Date.parse("2026-10-26T00:00:00Z"),
          12345,
          80,
          83,
          79,
          1000000,
          2.5,
          2,
          0.8,
        ],
      ],
    },
    {
      item: [
        [
          82,
          Date.parse("2026-10-26T00:00:00Z"),
          -1,
          80,
          83,
          79,
          1000000,
          2.5,
          2,
          0.8,
        ],
      ],
    },
  ])("rejects malformed external history %j", async (change) => {
    const { tasks } = setup({ ...klines(), ...change });
    await expect(
      tasks.filter((task) => task.provider === "xueqiu")[0]!.run(),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("preserves a null quantity rather than substituting zero", async () => {
    const data = klines();
    data.item[0]![2] = null;
    const { tasks } = setup(data);
    const result = await tasks
      .filter((task) => task.provider === "xueqiu")[0]!
      .run();
    expect(result.data.rows[0]!.values.volume).toBeNull();
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        field: "/data/rows/0/values/volume",
        code: "missing",
      }),
    );
  });

  it("maps a current quote without using forecast PE as dynamic PE", async () => {
    const { tasks, get } = setup(quote());
    const result = await tasks
      .find(
        ({ id, provider }) => id === "stock.snapshot" && provider === "xueqiu",
      )!
      .run();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v5/stock/quote.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: "SZ002594",
      extend: "detail",
    });
    expect(result.data.attributes).toEqual({
      name: "比亚迪",
      code: "002594",
      exchange: "SZ",
    });
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-10-26",
      asOf: "2026-10-26T07:34:15.000Z",
      values: {
        price: 82,
        volume: 12345,
        amount: 1000000,
        volumeRatio: 1.2,
        peDynamic: null,
        peStatic: 20,
        peTtm: 21,
        pb: 3,
        turnover: 0.8,
        totalShares: 100000000,
        floatShares: 50000000,
        marketCap: 8200000000,
        floatMarketCap: 4100000000,
      },
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        field: "/data/rows/0/values/peDynamic",
        code: "missing",
      }),
    );
  });

  it("rejects a quote after the fixed cutoff", async () => {
    const { tasks } = setup(
      quote({ timestamp: Date.parse("2026-10-28T07:30:00.000Z") }),
    );
    await expect(
      tasks
        .find(
          ({ id, provider }) =>
            id === "stock.snapshot" && provider === "xueqiu",
        )!
        .run(),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });

  it.each([
    { symbol: "SH600519" },
    { currency: "USD" },
    { timestamp: "today" },
    { name: "" },
    { volume: -1 },
  ])(
    "rejects malformed quote identity, timing and quantities %j",
    async (change) => {
      const { tasks } = setup(quote(change));
      await expect(
        tasks
          .find(
            ({ id, provider }) =>
              id === "stock.snapshot" && provider === "xueqiu",
          )!
          .run(),
      ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    },
  );
});
