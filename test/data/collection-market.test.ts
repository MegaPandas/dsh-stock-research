import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createChinaMarketTasks } from "../../src/data/collection-market.js";
import { HttpClient } from "../../src/data/http.js";

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
function setup(body: unknown, selectedScope = scope) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  vi.spyOn(http, "forSource").mockReturnValue(http);
  const get = vi.spyOn(http, "getText").mockResolvedValue(JSON.stringify(body));
  return { get, tasks: createChinaMarketTasks(http, selectedScope) };
}
function kline(date: string, volume = 123) {
  return `${date},80.97,82.40,82.62,80.97,${volume},2242715557.57,2.03,1.20,0.98,0.78`;
}
function response(lines: string[]) {
  return { rc: 0, data: { code: "002594", market: 0, klines: lines } };
}
function dates(count: number, step = 1, end = "2026-10-26"): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${end}T00:00:00Z`) - (count - i - 1) * step * 86400000)
      .toISOString()
      .slice(0, 10),
  );
}
afterEach(() => vi.restoreAllMocks());

describe("deterministic China market collection", () => {
  it.each([
    [0, "240", "2026-10-26", "2026-10-28", "2026-10-26T07:30:00.000Z"],
    [1, "1200", "2026-10-23", "2026-10-28", "2026-10-23T07:30:00.000Z"],
    [2, "7200", "2026-09-30", "2026-10-28", "2026-09-30T07:30:00.000Z"],
  ] as const)(
    "uses native Sina scale %s as the third source",
    async (index, scale, completed, unfinished, asOf) => {
      const { tasks, get } = setup(
        [completed, unfinished].map((day) => ({
          day,
          open: "1325.400",
          high: "1350.000",
          low: "1324.790",
          close: "1349.980",
          volume: "4159916",
        })),
      );
      const task = tasks.filter((task) => task.provider === "sina")[index]!;
      expect(task.provider).toBe("sina");
      const result = await task.run();
      expect(
        Object.fromEntries(new URL(String(get.mock.calls[0]![0])).searchParams),
      ).toEqual({ symbol: "sz002594", scale, ma: "no", datalen: "20000" });
      expect(result.source.provider).toBe("sina");
      expect(result.source.url).toContain("CN_MarketData.getKLineData");
      expect(result.data.adjustment).toBe("unadjusted");
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0]).toMatchObject({
        date: completed,
        asOf,
        values: {
          open: 1325.4,
          close: 1349.98,
          volume: 4159916,
          amount: null,
          turnover: null,
        },
      });
      expect(result.gaps.some((gap) => gap.field.endsWith("/amount"))).toBe(
        true,
      );
      expect(
        result.gaps.some((gap) => gap.detail.includes("fixed window requests")),
      ).toBe(true);
    },
  );

  it.each([
    [1, "week", "2026-10-19", "2026-10-26", "2026-10-23T07:30:00.000Z"],
    [2, "month", "2026-09-01", "2026-10-01", "2026-09-30T07:30:00.000Z"],
  ] as const)(
    "selects raw %s backup periods and excludes unfinished periods",
    async (index, period, completed, unfinished, asOf) => {
      const { tasks, get } = setup({
        code: 0,
        data: {
          sz002594: {
            [period]: [completed, unfinished].map((date) => [
              date,
              "80",
              "82",
              "83",
              "79",
              "100",
            ]),
            day: [["2026-10-23", "1", "1", "1", "1", "1"]],
            [`qfq${period}`]: [[completed, "1", "1", "1", "1", "1"]],
          },
        },
      });
      const result = await tasks
        .filter((task) => task.provider === "tencent")
        .at(index)!
        .run();
      expect(
        new URL(String(get.mock.calls[0]![0])).searchParams
          .get("param")!
          .split(",")[1],
      ).toBe(period);
      expect(
        new URL(String(get.mock.calls[0]![0])).searchParams
          .get("param")!
          .split(",")[4],
      ).toBe(period === "week" ? "59" : "36");
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0]).toMatchObject({
        date: completed,
        asOf,
        values: { open: 80, volume: 10000, amount: null, changePercent: null },
      });
      expect(result.data.adjustment).toBe("unadjusted");
      expect(result.data.columns.volume!.unit).toBe("shares");
      expect(result.source.provider).toBe("tencent");
      expect(result.gaps.some((gap) => gap.field.endsWith("/amount"))).toBe(
        true,
      );
      expect(
        tasks.filter((task) => task.provider === "tencent")[index]!.endpoint,
      ).toBe("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
    },
  );

  it("has one fixed task per dataset and all price periods declare Tencent fallbacks", () => {
    const { tasks, get } = setup({});
    expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )
        .map((task) => task.id),
    ).toEqual([
      "market.daily",
      "market.weekly",
      "market.monthly",
      "market.averages",
      "valuation.history",
      "stock.snapshot",
    ]);
    expect(
      tasks
        .filter((task) => task.provider === "tencent")
        .map((task) => [task.id, task.provider]),
    ).toEqual([
      ["market.daily", "tencent"],
      ["market.weekly", "tencent"],
      ["market.monthly", "tencent"],
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches and retains 60 daily bars with source statistics, converting lots to shares only", async () => {
    const { tasks, get } = setup(
      response(dates(70).map((date) => kline(date))),
    );
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[0]!
      .run();
    expect(get).toHaveBeenCalledTimes(1);
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      secid: "0.002594",
      klt: "101",
      fqt: "0",
      beg: "20260629",
      lmt: "60",
      end: "20261027",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    });
    expect(envelope.data.rows).toHaveLength(60);
    expect(envelope.data.rows.at(-1)!.values).toEqual({
      open: 80.97,
      close: 82.4,
      high: 82.62,
      low: 80.97,
      volume: 12300,
      amount: 2242715557.57,
      amplitude: 2.03,
      changePercent: 1.2,
      change: 0.98,
      turnover: 0.78,
    });
    expect(envelope.data.columns.volume!.unit).toBe("shares");
    expect(envelope.data.columns.turnover!.unit).toBe("percent");
    expect(envelope.historicalKnowledge).toBe("unverified");
    expect(envelope.gaps.some((gap) => gap.code === "unverified_time")).toBe(
      true,
    );
  });

  it("clips the daily backup request to its coverage start and preserves a short history gap", async () => {
    const selectedScope = {
      ...scope,
      date: "2024-01-03",
      cutoff: "2024-01-03T15:59:59.999Z",
    };
    const { tasks, get } = setup(
      {
        code: 0,
        data: {
          sz002594: {
            day: [
              ["2024-01-02", "80", "82", "83", "79", "100"],
              ["2024-01-03", "81", "82", "83", "80", "200"],
            ],
          },
        },
      },
      selectedScope,
    );
    const envelope = await tasks
      .filter((task) => task.provider === "tencent")[0]!
      .run();
    expect(get).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams.get("param"),
    ).toBe("sz002594,day,2024-01-01,2024-01-03,3,");
    expect(envelope.source.provider).toBe("tencent");
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2024-01-02",
      "2024-01-03",
    ]);
    expect(envelope.data.rows[0]!.values.volume).toBe(10000);
    expect(envelope.gaps).toContainEqual({
      code: "missing",
      field: "/data/rows",
      detail:
        "The source returned 2 observations; the fixed window requests 60.",
    });
  });

  it("requests weekly bars directly and omits the incomplete current week", async () => {
    const { tasks, get } = setup(
      response([kline("2026-10-16"), kline("2026-10-23"), kline("2026-10-26")]),
    );
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[1]!
      .run();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.searchParams.get("klt")).toBe("102");
    expect(url.searchParams.get("lmt")).toBe("52");
    expect(url.searchParams.get("end")).toBe("20261023");
    expect(url.searchParams.get("beg")).toBe("20250912");
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2026-10-16",
      "2026-10-23",
    ]);
    expect(envelope.data.interval).toBe("1wk");
    expect(envelope.gaps.some((gap) => gap.field === "/data/columns/ma")).toBe(
      true,
    );
  });

  it("requests monthly bars directly and omits the incomplete current month", async () => {
    const { tasks, get } = setup(
      response([kline("2026-08-31"), kline("2026-09-30"), kline("2026-10-26")]),
    );
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[2]!
      .run();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      klt: "103",
      beg: "20231001",
      lmt: "36",
      end: "20260930",
    });
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2026-08-31",
      "2026-09-30",
    ]);
    expect(envelope.data.interval).toBe("1mo");
  });

  it("does not include an unfinished daily bar before its session end", async () => {
    const selectedScope = { ...scope, cutoff: "2026-10-27T06:00:00.000Z" };
    const { tasks, get } = setup(
      response([kline("2026-10-26"), kline("2026-10-27")]),
      selectedScope,
    );
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[0]!
      .run();
    expect(new URL(String(get.mock.calls[0]![0])).searchParams.get("end")).toBe(
      "20261026",
    );
    expect(envelope.data.rows.map((row) => row.date)).toEqual(["2026-10-26"]);
  });

  it("returns vendor MA values verbatim and records the absent MA60 without calculating it", async () => {
    const { tasks, get } = setup([
      {
        day: "2026-10-26",
        ma_price5: 81.428,
        ma_price10: 81.922,
        ma_price20: 83.058,
        ma_price30: 83.687,
        ma_volume5: 27971469,
        ma_volume10: 26192388,
        ma_volume20: 25449800,
        ma_volume30: 25043350,
      },
    ]);
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[3]!
      .run();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      symbol: "sz002594",
      scale: "240",
      ma: "5,10,20,30,60",
      datalen: "60",
    });
    expect(envelope.data.rows[0]!.values).toMatchObject({
      ma5: 81.428,
      ma10: 81.922,
      ma20: 83.058,
      ma30: 83.687,
      volumeMa5: 27971469,
    });
    expect(envelope.data.rows[0]!.values).not.toHaveProperty("ma60");
    expect(
      envelope.gaps.some((gap) => gap.field === "/data/columns/ma60"),
    ).toBe(true);
  });

  it("reports an unavailable historical MA window instead of adopting current source values", async () => {
    const { tasks, get } = setup([{ day: "2026-10-26", ma_price5: 81.428 }], {
      ...scope,
      date: "2024-01-03",
      cutoff: "2024-01-03T15:59:59.999Z",
    });
    await expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )[3]!
        .run(),
    ).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
      message: expect.stringContaining("current rolling window"),
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps historical valuation source multiples and dates separate from quote snapshots", async () => {
    const { tasks, get } = setup({
      success: true,
      code: 0,
      result: {
        pages: 10,
        count: 600,
        data: [
          {
            SECURITY_CODE: "002594",
            TRADE_DATE: "2026-10-26 00:00:00",
            PE_TTM: 25.52353429,
            PE_LAR: 23.03125702,
            PB_MRQ: 3.13060866,
            TOTAL_MARKET_CAP: 751257079356,
          },
        ],
      },
    });
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[4]!
      .run();
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams.get("reportName"),
    ).toBe("RPT_VALUEANALYSIS_DET");
    expect(envelope.data.table).toBe("valuation.history");
    expect(envelope.data.rows[0]!.values).toMatchObject({
      PE_TTM: 25.52353429,
      PB_MRQ: 3.13060866,
    });
    expect(envelope.data.columns.PE_TTM!.unit).toBe("multiple");
  });

  it("normalizes documented source decimal precision in the current quote and retains identity", async () => {
    const { tasks } = setup({
      rc: 0,
      data: {
        f57: "002594",
        f58: "比亚迪",
        f59: 2,
        f152: 2,
        f86: Date.parse("2026-10-26T07:34:15Z") / 1000,
        f43: 8240,
        f47: 273322,
        f48: 2242715557.57,
        f50: 102,
        f162: 3048,
        f163: 2303,
        f164: 2552,
        f167: 313,
        f168: 78,
      },
    });
    const envelope = await tasks
      .filter(
        (task) =>
          task.provider === "eastmoney" || task.id === "market.averages",
      )[5]!
      .run();
    expect(envelope.data.basis).toBe("current_quote");
    expect(envelope.data.attributes).toEqual({
      name: "比亚迪",
      code: "002594",
      exchange: "SZ",
    });
    expect(envelope.data.rows[0]!.values).toMatchObject({
      price: 82.4,
      volume: 27332200,
      peDynamic: 30.48,
      peStatic: 23.03,
      peTtm: 25.52,
      pb: 3.13,
      turnover: 0.78,
      volumeRatio: 1.02,
    });
  });

  it("rejects a current quote that would introduce information after historical cutoff", async () => {
    const { tasks } = setup({
      rc: 0,
      data: {
        f57: "002594",
        f58: "比亚迪",
        f59: 2,
        f152: 2,
        f86: Date.parse("2026-10-28T07:34:15Z") / 1000,
      },
    });
    await expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )[5]!
        .run(),
    ).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
  });

  it("rejects contradictory prices and a mismatched security at the source boundary", async () => {
    const { tasks, get } = setup(
      response(["2026-10-26,80,90,85,79,100,1000,2,1,1,1"]),
    );
    await expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )[0]!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    get.mockResolvedValue(
      JSON.stringify({
        rc: 0,
        data: { code: "600519", market: 1, klines: [] },
      }),
    );
    await expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )[0]!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("propagates transport errors without trying the declared backup itself", async () => {
    const { tasks, get } = setup({});
    const failure = new Error("network unavailable");
    get.mockRejectedValue(failure);
    await expect(
      tasks
        .filter(
          (task) =>
            task.provider === "eastmoney" || task.id === "market.averages",
        )[0]!
        .run(),
    ).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
