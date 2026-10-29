import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBenchmarkMarketTasks } from "../../src/data/collection-benchmarks.js";
import { HttpClient } from "../../src/data/http.js";
import { XueqiuClient } from "../../src/data/xueqiu.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-29",
  cutoff: "2026-10-29T12:00:00.000Z",
};
function fixture(period: "week" | "month") {
  return JSON.parse(
    readFileSync(
      new URL(
        `../fixtures/sources/xueqiu-usdcnh-${period}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}
function setup() {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText");
  const client = new XueqiuClient(http, "session=fixture");
  const tasks = createBenchmarkMarketTasks(http, scope, client);
  return { get, tasks };
}
afterEach(() => vi.restoreAllMocks());

describe("Xueqiu benchmark periods", () => {
  it.each([
    ["usdcny", "USDCNY.FX", "CNY/USD"],
    ["eurusd", "EURUSD.FX", "USD/EUR"],
    ["usdjpy", "USDJPY.FX", "JPY/USD"],
  ])("keeps the verified %s quote direction", async (asset, symbol, unit) => {
    const { get, tasks } = setup();
    const snapshots = JSON.parse(
      readFileSync(
        new URL("../fixtures/sources/xueqiu-forex-week.json", import.meta.url),
        "utf8",
      ),
    );
    get.mockResolvedValue(
      JSON.stringify({ error_code: 0, data: snapshots[symbol!] }),
    );
    const result = await tasks
      .find(({ id }) => id === `benchmark.${asset}.weekly`)!
      .fallback!.run();
    expect(result.data.attributes!.quoteDirection).toBe(unit);
    expect(result.data.columns.close!.unit).toBe(unit);
    expect(result.data.rows).toHaveLength(1);
    expect(
      new URL(String(get.mock.lastCall![0])).searchParams.get("symbol"),
    ).toBe(symbol);
  });
  it.each([
    ["week", "weekly", "1wk", "52", "2026-10-23", 6.6691],
    ["month", "monthly", "1mo", "36", "2026-09-30", 6.7089],
  ] as const)(
    "reads native %s USD/CNH bars and excludes the current period",
    async (period, suffix, interval, count, date, close) => {
      const { get, tasks } = setup();
      get.mockResolvedValue(JSON.stringify(fixture(period)));
      const result = await tasks
        .find(({ id }) => id === `benchmark.usdcnh.${suffix}`)!
        .fallback!.run();
      const url = new URL(String(get.mock.lastCall![0]));
      expect(url.pathname).toBe("/v5/stock/chart/kline.json");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        symbol: "USDCNH.FX",
        period,
        type: "normal",
        count: `-${count}`,
        begin: String(Date.parse(`${date}T23:59:59.999Z`)),
      });
      expect(result.source.provider).toBe("xueqiu");
      expect(result.data).toMatchObject({
        interval,
        currency: "CNH",
        basis: "source_reported_ohlc",
        attributes: {
          assetCode: "USD/CNH",
          quoteDirection: "CNH/USD",
          sourceTimeZone: "Asia/Shanghai",
        },
        columns: { close: { unit: "CNH/USD" } },
      });
      expect(result.data.rows).toHaveLength(2);
      expect(result.data.rows.at(-1)).toMatchObject({
        date,
        asOf: `${date}T23:59:59.999Z`,
        values: { close },
      });
      expect(result.data.columns).not.toHaveProperty("volume");
      expect(JSON.stringify(result)).not.toContain("session=fixture");
    },
  );

  it("keeps the daily Sina fallback after Xueqiu and does not enable unverified gold symbols", () => {
    const { tasks, get } = setup();
    const daily = tasks.find(({ id }) => id === "benchmark.usdcnh.daily")!;
    expect(daily.provider).toBe("eastmoney");
    expect(daily.fallback!.provider).toBe("xueqiu");
    expect(daily.fallback!.fallback!.provider).toBe("sina");
    expect(
      tasks.find(({ id }) => id === "benchmark.gold.weekly")!.fallback,
    ).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps daily missing prices and excludes unfinished days", async () => {
    const { get, tasks } = setup();
    get.mockResolvedValue(
      JSON.stringify({
        error_code: 0,
        data: {
          symbol: "USDCNH.FX",
          column: ["timestamp", "open", "high", "low", "close"],
          item: [
            [Date.parse("2026-10-28T04:00:00Z"), 6.66, 6.67, 6.65, null],
            [Date.parse("2026-10-29T04:00:00Z"), 6.66, 6.67, 6.65, 6.66],
          ],
        },
      }),
    );
    const result = await tasks
      .find(({ id }) => id === "benchmark.usdcnh.daily")!
      .fallback!.run();
    expect(result.data.rows.map(({ date }) => date)).toEqual(["2026-10-28"]);
    expect(result.data.rows[0]!.values.close).toBeNull();
  });

  it.each(["identity", "column", "length", "ohlc"])(
    "rejects invalid benchmark %s",
    async (failure) => {
      const { get, tasks } = setup();
      const raw = fixture("week");
      if (failure === "identity") raw.data.symbol = "USDCNY.FX";
      if (failure === "column") raw.data.column[0] = "other";
      if (failure === "length") raw.data.item[0].pop();
      if (failure === "ohlc")
        raw.data.item[0][raw.data.column.indexOf("close")] = 100;
      get.mockResolvedValue(JSON.stringify(raw));
      await expect(
        tasks
          .find(({ id }) => id === "benchmark.usdcnh.weekly")!
          .fallback!.run(),
      ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    },
  );
});
