import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createBenchmarkMarketTasks } from "../../src/data/collection-benchmarks.js";
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
function line(date: string, close = "101.75", volume = "552842912") {
  return `${date},101.63,${close},101.86,101.49,${volume},898666874902.30,0.36,0.13,0.13,0.00`;
}
function eastmoney(secid: string, lines = [line("2026-09-30")]) {
  const [market, code] = secid.split(".");
  return {
    rc: 0,
    data: { code, market: Number(market), name: "源站基准名称", klines: lines },
  };
}
function yahoo(
  interval = "1d",
  timestamps = [Date.parse("2026-09-29T23:00:00Z") / 1000],
  quote?: Record<string, unknown>,
) {
  return {
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
            longName: "USD/CNY",
          },
          timestamp: timestamps,
          indicators: {
            quote: [quote ?? { close: timestamps.map(() => 6.68) }],
          },
        },
      ],
    },
  };
}
function primaryTasks(tasks: ReturnType<typeof createBenchmarkMarketTasks>) {
  return tasks.filter(
    (task, index) => tasks.findIndex((other) => other.id === task.id) === index,
  );
}
function setup(selectedScope = scope) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  vi.spyOn(http, "forSource").mockReturnValue(http);
  const get = vi.spyOn(http, "getText").mockImplementation(async (address) => {
    const url = new URL(String(address));
    return JSON.stringify(
      url.hostname.includes("yahoo")
        ? yahoo(url.searchParams.get("interval")!)
        : eastmoney(url.searchParams.get("secid")!),
    );
  });
  return { get, tasks: createBenchmarkMarketTasks(http, selectedScope) };
}
afterEach(() => vi.restoreAllMocks());

describe("fixed benchmark market collection", () => {
  it("classifies invalid Sina FX JSON as a recoverable source failure", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue('benchmark=("\\q");');
    await expect(
      tasks
        .find(
          ({ id, provider }) =>
            id === "benchmark.gold.daily" && provider === "sina",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      cause: expect.any(SyntaxError),
    });
  });

  it.each([
    ["dxy", "DX-Y.NYB", "USD", "INDEX", "DXY"],
    ["eurusd", "EURUSD=X", "USD", "CURRENCY", "EUR/USD"],
    ["usdjpy", "USDJPY=X", "JPY", "CURRENCY", "USD/JPY"],
  ])(
    "uses independent Yahoo native periods for %s",
    async (id, symbol, currency, instrumentType, identity) => {
      const { tasks, get } = setup();
      for (const [suffix, interval, date] of [
        ["daily", "1d", "2026-10-23"],
        ["weekly", "1wk", "2026-10-19"],
        ["monthly", "1mo", "2026-09-01"],
      ]) {
        const response = yahoo(
          interval,
          [Date.parse(`${date}T12:00:00Z`) / 1000],
          { close: [101] },
        );
        Object.assign(response.chart.result[0]!.meta, {
          symbol,
          currency,
          instrumentType,
        });
        get.mockResolvedValue(JSON.stringify(response));
        const task = tasks.find(
          (task) => task.id === `benchmark.${id}.${suffix}`,
        )!;
        expect(task.provider).toBe("eastmoney");
        const result = await tasks
          .find((other) => other.id === task.id && other.provider === "yahoo")!
          .run();
        expect(result.source.provider).toBe("yahoo");
        expect(result.data.attributes!.assetCode).toBe(identity);
        expect(result.data.rows[0]!.values).toEqual({ close: 101 });
        expect(
          new URL(String(get.mock.lastCall![0])).searchParams.get("interval"),
        ).toBe(interval);
        response.chart.result[0]!.meta.instrumentType = "FUTURE";
        get.mockResolvedValue(JSON.stringify(response));
        await expect(
          tasks
            .find(
              (other) => other.id === task.id && other.provider === "yahoo",
            )!
            .run(),
        ).rejects.toMatchObject({
          code: "SOURCE_UNAVAILABLE",
        });
      }
    },
  );

  it.each([
    ["gold", "fx_sxauusd", "XAU/USD", "USD/troy_ounce"],
    ["usdcnh", "fx_susdcnh", "USD/CNH", "CNH/USD"],
  ])(
    "uses exact Sina daily %s without fabricating native weeks/months",
    async (id, symbol, identity, unit) => {
      const { tasks, get } = setup();
      const task = tasks.find((task) => task.id === `benchmark.${id}.daily`)!;
      get.mockResolvedValue(
        '/* publisher header */\nbenchmark=("2026-10-23,100,99,102,101,|2026-10-26,100,99,102,101,|2026-10-27,100,99,102,101");',
      );
      const result = await tasks
        .find((other) => other.id === task.id && other.provider === "sina")!
        .run();
      expect(
        new URL(String(get.mock.lastCall![0])).searchParams.get("symbol"),
      ).toBe(symbol);
      expect(result.source.provider).toBe("sina");
      expect(result.data.attributes).toMatchObject({
        assetCode: identity,
        unit,
        calendar: "global_weekdays_utc",
      });
      expect(result.data.rows.map((row) => row.date)).toEqual([
        "2026-10-23",
        "2026-10-26",
      ]);
      expect(result.data.rows[0]!.values).toMatchObject({
        open: 100,
        low: 99,
        high: 102,
        close: 101,
      });
      expect(result.data.columns).not.toHaveProperty("volume");
      if (id === "gold") {
        expect(result.data.attributes!.sourceMethodology).toBe(
          "publisher_calculated_spot_cross",
        );
        expect(
          result.gaps.some(
            (gap) => gap.field === "/data/attributes/sourceMethodology",
          ),
        ).toBe(true);
      }
      expect(
        tasks.find(
          (task) =>
            task.id === `benchmark.${id}.weekly` && task.provider === "sina",
        ),
      ).toBeUndefined();
      expect(
        tasks.find(
          (task) =>
            task.id === `benchmark.${id}.monthly` && task.provider === "sina",
        ),
      ).toBeUndefined();
      get.mockResolvedValue('anotherSymbol=("2026-10-23,100,99,102,101");');
      await expect(
        tasks
          .find((other) => other.id === task.id && other.provider === "sina")!
          .run(),
      ).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      get.mockResolvedValue('benchmark=("2026-10-23,100,99,102,103");');
      await expect(
        tasks
          .find((other) => other.id === task.id && other.provider === "sina")!
          .run(),
      ).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
    },
  );

  it.each([
    ["shanghai", "sh000001"],
    ["shenzhen", "sz399001"],
    ["csi300", "sh000300"],
    ["chinext", "sz399006"],
  ])(
    "appends independent Sina native index periods for %s",
    async (id, symbol) => {
      const { tasks, get } = setup();
      for (const [suffix, scale, date] of [
        ["daily", "240", "2026-10-23"],
        ["weekly", "1200", "2026-10-23"],
        ["monthly", "7200", "2026-09-30"],
      ]) {
        get.mockResolvedValue(
          JSON.stringify([
            {
              day: date,
              open: "100",
              low: "99",
              high: "102",
              close: "101",
              volume: "12300",
            },
          ]),
        );
        const result = await tasks
          .find(
            (task) =>
              task.id === `benchmark.${id}.${suffix}` &&
              task.provider === "sina",
          )!
          .run();
        expect(result.source.provider).toBe("sina");
        expect(result.data.rows[0]!.values).toMatchObject({
          close: 101,
          volume: 123,
          amount: null,
        });
        expect(result.data.columns.volume!.unit).toBe("lots");
        const url = new URL(String(get.mock.lastCall![0]));
        expect(url.searchParams.get("scale")).toBe(scale);
        expect(url.searchParams.get("symbol")).toBe(symbol);
      }
    },
  );

  it("preserves absent index volume and filters unfinished Tencent weeks", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify({
        code: 0,
        data: {
          sh000001: {
            week: [
              ["2026-10-19", "100", "101", "102", "99", "-"],
              ["2026-10-26", "100", "101", "102", "99", "123"],
            ],
          },
        },
      }),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.shanghai.weekly" &&
          task.provider === "tencent",
      )!
      .run();
    expect(result.data.rows.map((row) => row.date)).toEqual(["2026-10-19"]);
    expect(result.data.rows[0]!.values.volume).toBeNull();
    expect(result.gaps.some((gap) => gap.field.endsWith("/volume"))).toBe(true);
  });

  it.each([
    ["shanghai", "sh000001", "CN:000001.SH"],
    ["shenzhen", "sz399001", "CN:399001.SZ"],
    ["csi300", "sh000300", "CN:000300.SH"],
    ["chinext", "sz399006", "CN:399006.SZ"],
  ])(
    "supplies raw Tencent periods for %s with index lots and missing amounts",
    async (id, symbol, assetCode) => {
      const { tasks, get } = setup();
      for (const [period, suffix, date] of [
        ["day", "daily", "2026-10-23"],
        ["week", "weekly", "2026-10-19"],
        ["month", "monthly", "2026-09-01"],
      ]) {
        get.mockResolvedValue(
          JSON.stringify({
            code: 0,
            data: {
              [symbol!]: {
                [period!]: [[date, "100", "101", "102", "99", "123"]],
              },
            },
          }),
        );
        const task = tasks.find(
          (task) => task.id === `benchmark.${id}.${suffix}`,
        )!;
        const result = await tasks
          .find(
            (other) => other.id === task.id && other.provider === "tencent",
          )!
          .run();
        expect(
          new URL(String(get.mock.lastCall![0])).searchParams
            .get("param")!
            .split(",")
            .slice(0, 2),
        ).toEqual([symbol, period]);
        expect(
          new URL(String(get.mock.lastCall![0])).searchParams
            .get("param")!
            .split(",")[4],
        ).toBe(period === "day" ? "121" : period === "week" ? "59" : "36");
        expect(result.source.provider).toBe("tencent");
        expect(result.data.attributes!.assetCode).toBe(assetCode);
        expect(result.data.columns.volume!.unit).toBe("lots");
        expect(result.data.rows[0]!.values).toMatchObject({
          open: 100,
          close: 101,
          volume: 123,
          amount: null,
          change: null,
        });
        expect(result.gaps.some((gap) => gap.field.endsWith("/amount"))).toBe(
          true,
        );
        expect(result.gaps.some((gap) => gap.field === "/data/rows")).toBe(
          true,
        );
      }
      expect(
        primaryTasks(tasks).filter(
          (task) => tasks.filter((other) => other.id === task.id).length > 1,
        ),
      ).toHaveLength(23);
    },
  );

  it("declares exactly the ten fixed instruments across three direct source periods", () => {
    const { tasks, get } = setup();
    const assets = [
      "shanghai",
      "shenzhen",
      "csi300",
      "chinext",
      "gold",
      "dxy",
      "usdcny",
      "usdcnh",
      "eurusd",
      "usdjpy",
    ];
    expect(primaryTasks(tasks).map((task) => task.id)).toEqual(
      assets.flatMap((asset) =>
        ["daily", "weekly", "monthly"].map(
          (period) => `benchmark.${asset}.${period}`,
        ),
      ),
    );
    expect(new Set(tasks.map((task) => task.id)).size).toBe(30);
    expect(tasks.every((task) => task.dataset === "market")).toBe(true);
    expect(
      primaryTasks(tasks)
        .filter((task) => task.provider === "yahoo")
        .map((task) => task.id),
    ).toEqual([
      "benchmark.usdcny.daily",
      "benchmark.usdcny.weekly",
      "benchmark.usdcny.monthly",
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it("uses bounded source dates and asks for each Chinese index period directly", async () => {
    const { tasks, get } = setup();
    for (const task of tasks.filter(
      (task) =>
        task.id.startsWith("benchmark.shanghai.") &&
        task.provider === "eastmoney",
    ))
      await task.run();
    const requests = get.mock.calls.map((call) =>
      Object.fromEntries(new URL(String(call[0])).searchParams),
    );
    expect(
      requests.map((request) => [
        request.secid,
        request.klt,
        request.lmt,
        request.beg,
        request.end,
      ]),
    ).toEqual([
      ["1.000001", "101", "60", "20260629", "20261027"],
      ["1.000001", "102", "52", "20250912", "20261023"],
      ["1.000001", "103", "36", "20231001", "20260930"],
    ]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["shanghai", "CN:000001.SH", "index", "index", "china_exchange"],
    ["shenzhen", "CN:399001.SZ", "index", "index", "china_exchange"],
    ["csi300", "CN:000300.SH", "index", "index", "china_exchange"],
    ["chinext", "CN:399006.SZ", "index", "index", "china_exchange"],
    ["gold", "XAU/USD", "gold", "USD/troy_ounce", "global_weekdays_utc"],
    ["dxy", "DXY", "dollarIndex", "index", "global_weekdays_utc"],
    ["usdcny", "USD/CNY", "fx", "CNY/USD", "global_weekdays_utc"],
    ["usdcnh", "USD/CNH", "fx", "CNH/USD", "global_weekdays_utc"],
    ["eurusd", "EUR/USD", "fx", "USD/EUR", "global_weekdays_utc"],
    ["usdjpy", "USD/JPY", "fx", "JPY/USD", "global_weekdays_utc"],
  ] as const)(
    "retains the independent benchmark identity and unit for task %i",
    async (asset, assetCode, assetType, unit, calendar) => {
      const { tasks } = setup();
      const result = await tasks
        .find(
          (task) =>
            task.id === `benchmark.${asset}.daily` &&
            task.provider === (asset === "usdcny" ? "yahoo" : "eastmoney"),
        )!
        .run();
      expect(result.data.attributes).toMatchObject({
        assetCode,
        assetType,
        unit,
        calendar,
      });
      expect(result.data.attributes!.name).not.toContain("比亚迪");
      expect(result.data.columns.close!.unit).toBe(unit);
      expect(
        Object.values(result.data.columns).some(
          (column) => column.unit === "shares",
        ),
      ).toBe(false);
      if (assetType === "gold")
        expect(result.data.attributes!.instrument).toBe("spot");
      if (assetType === "fx")
        expect(result.data.attributes!.quoteDirection).toBe(unit);
    },
  );

  it("retains Chinese index source volume in lots and amount in yuan without scaling to shares", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(eastmoney("1.000001", [line("2026-10-26")])),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.shanghai.daily" &&
          task.provider === "eastmoney",
      )!
      .run();
    expect(result.data.rows[0]!.values.volume).toBe(552842912);
    expect(result.data.rows[0]!.values.amount).toBe(898666874902.3);
    expect(result.data.columns.volume).toEqual({
      label: "成交量（手）",
      unit: "lots",
    });
    expect(result.data.columns.amount!.unit).toBe("CNY");
  });

  it("does not reinterpret zero global volume placeholders as an established trading quantity", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(eastmoney("122.XAU", [line("2026-10-23", "101.75", "0")])),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.gold.daily" && task.provider === "eastmoney",
      )!
      .run();
    expect(result.data.columns).not.toHaveProperty("volume");
    expect(result.data.rows[0]!.values).not.toHaveProperty("volume");
    expect(
      result.gaps.some(
        (gap) => gap.code === "missing" && gap.field === "/data/columns/volume",
      ),
    ).toBe(true);
  });

  it("excludes the incomplete UTC day and does not use the Chinese closing time for global data", async () => {
    const { tasks, get } = setup({
      ...scope,
      cutoff: "2026-10-26T17:00:00.000Z",
    });
    get.mockResolvedValue(
      JSON.stringify(
        eastmoney("122.XAU", [line("2026-10-23"), line("2026-10-26")]),
      ),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.gold.daily" && task.provider === "eastmoney",
      )!
      .run();
    expect(new URL(String(get.mock.calls[0]![0])).searchParams.get("end")).toBe(
      "20261025",
    );
    expect(result.data.rows.map((row) => row.date)).toEqual(["2026-10-23"]);
    expect(result.data.rows[0]!.asOf).toBe("2026-10-23T23:59:59.999Z");
  });

  it("keeps the current global week incomplete until Friday UTC has ended", async () => {
    const { tasks, get } = setup({
      ...scope,
      date: "2026-10-23",
      cutoff: "2026-10-23T20:00:00.000Z",
    });
    get.mockResolvedValue(
      JSON.stringify(
        eastmoney("100.UDI", [line("2026-10-16"), line("2026-10-23")]),
      ),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.dxy.weekly" && task.provider === "eastmoney",
      )!
      .run();
    expect(new URL(String(get.mock.calls[0]![0])).searchParams.get("end")).toBe(
      "20261016",
    );
    expect(result.data.rows.map((row) => row.date)).toEqual(["2026-10-16"]);
  });

  it("keeps a global month incomplete after the Chinese month close but before UTC month-end", async () => {
    const { tasks, get } = setup({
      ...scope,
      date: "2026-09-30",
      cutoff: "2026-09-30T15:00:00.000Z",
    });
    get.mockResolvedValue(
      JSON.stringify(
        eastmoney("122.XAU", [line("2026-08-31"), line("2026-09-30")]),
      ),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.gold.monthly" && task.provider === "eastmoney",
      )!
      .run();
    expect(new URL(String(get.mock.calls[0]![0])).searchParams.get("end")).toBe(
      "20260831",
    );
    expect(result.data.rows.map((row) => row.date)).toEqual(["2026-08-31"]);
    expect(result.data.rows[0]!.asOf).toBe("2026-08-31T23:59:59.999Z");
  });

  it("converts Yahoo timestamps to the source trading date before deciding UTC completion across London DST", async () => {
    const { tasks, get } = setup({
      ...scope,
      date: "2026-07-06",
      cutoff: "2026-07-06T12:00:00.000Z",
    });
    get.mockResolvedValue(
      JSON.stringify(
        yahoo("1d", [
          Date.parse("2026-07-02T23:00:00Z") / 1000,
          Date.parse("2026-07-05T23:00:00Z") / 1000,
        ]),
      ),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
      )!
      .run();
    expect(result.data.rows.map((row) => row.date)).toEqual(["2026-07-03"]);
    expect(result.data.rows[0]!.asOf).toBe("2026-07-03T23:59:59.999Z");
    expect(result.data.attributes!.sourceTimeZone).toBe("Europe/London");
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v8/finance/chart/CNY%3DX");
    expect(url.searchParams.get("interval")).toBe("1d");
  });

  it("requests source weekly and monthly closing-rate charts without daily aggregation", async () => {
    const { tasks, get } = setup();
    for (const period of ["weekly", "monthly"]) {
      const result = await tasks
        .find(
          (task) =>
            task.id === `benchmark.usdcny.${period}` &&
            task.provider === "yahoo",
        )!
        .run();
      expect(Object.keys(result.data.columns)).toEqual(["close"]);
      expect(result.data.rows[0]!.values).toEqual({ close: 6.68 });
      expect(result.data.basis).toBe("source_reported_close");
    }
    expect(
      get.mock.calls.map((call) =>
        new URL(String(call[0])).searchParams.get("interval"),
      ),
    ).toEqual(["1wk", "1mo"]);
  });

  it("accepts the observed Yahoo USDCNY=X alias while retaining the requested USD/CNY identity", async () => {
    const { tasks, get } = setup();
    const response = yahoo("1d", [1792710000], {
      open: [6.6778998374938965],
      close: [6.6778998374938965],
      high: [6.6778998374938965],
      low: [6.6778998374938965],
      volume: [0],
    });
    response.chart.result[0]!.meta.symbol = "USDCNY=X";
    get.mockResolvedValue(JSON.stringify(response));
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
      )!
      .run();
    expect(result.data.attributes).toMatchObject({
      assetCode: "USD/CNY",
      sourceName: "USD/CNY",
      unit: "CNY/USD",
    });
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-10-23",
      values: { close: 6.6778998374938965 },
    });
    response.chart.result[0]!.meta.symbol = "USDCNH=X";
    get.mockResolvedValue(JSON.stringify(response));
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("preserves the observed USD/CNY closing rate without publishing inconsistent source OHLC", async () => {
    const { tasks, get } = setup();
    const response = yahoo("1d", [1787871600], {
      open: [6.719799995422363],
      high: [6.719799995422363],
      low: [6.719799995422363],
      close: [6.722499847412109],
      volume: [0],
    });
    response.chart.result[0]!.meta.symbol = "USDCNY=X";
    get.mockResolvedValue(JSON.stringify(response));
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
      )!
      .run();
    expect(result.data.columns).toEqual({
      close: { label: "收盘汇率", unit: "CNY/USD" },
    });
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-08-28",
      values: { close: 6.722499847412109 },
    });
    expect(Object.keys(result.data.rows[0]!.values)).toEqual(["close"]);
    expect(result.data.basis).toBe("source_reported_close");
    expect(
      result.gaps.some(
        (gap) =>
          gap.field === "/data/columns/ohlc" && gap.code === "incomparable",
      ),
    ).toBe(true);
  });

  it("requires matching timestamps and closing-rate counts even though other Yahoo OHLC arrays are unused", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(yahoo("1d", [1792623600, 1792710000], { close: [6.68] })),
    );
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("retains missing closing rates and rejects nonpositive rates", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(yahoo("1d", [1792710000], { close: [null] })),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
      )!
      .run();
    expect(result.data.rows[0]!.values).toEqual({ close: null });
    expect(
      result.gaps.some((gap) => gap.field === "/data/rows/0/values/close"),
    ).toBe(true);
    get.mockResolvedValue(
      JSON.stringify(yahoo("1d", [1792710000], { close: [0] })),
    );
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("continues to reject contradictory Eastmoney benchmark OHLC", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(eastmoney("100.UDI", [line("2026-10-23", "120")])),
    );
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.dxy.daily" && task.provider === "eastmoney",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("preserves missing OHLC source values and reports their field gap", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(eastmoney("100.UDI", [line("2026-10-23", "-")])),
    );
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.dxy.daily" && task.provider === "eastmoney",
      )!
      .run();
    expect(result.data.rows[0]!.values.close).toBeNull();
    expect(
      result.gaps.some((gap) => gap.field === "/data/rows/0/values/close"),
    ).toBe(true);
  });

  it("rejects source identity and quote-direction mismatches", async () => {
    const { tasks, get } = setup();
    get.mockResolvedValue(JSON.stringify(eastmoney("120.USDCNYC")));
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.usdcnh.daily" &&
            task.provider === "eastmoney",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    const wrong = yahoo();
    wrong.chart.result[0]!.meta.currency = "USD";
    get.mockResolvedValue(JSON.stringify(wrong));
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.usdcny.daily" && task.provider === "yahoo",
        )!
        .run(),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("trims excess provider output to the fixed window and propagates transport errors without another source", async () => {
    const { tasks, get } = setup();
    const lines = Array.from({ length: 80 }, (_, index) =>
      new Date(Date.parse("2026-10-26T00:00:00Z") - (79 - index) * 86400000)
        .toISOString()
        .slice(0, 10),
    ).map((date) => line(date));
    get.mockResolvedValue(JSON.stringify(eastmoney("1.000001", lines)));
    const result = await tasks
      .find(
        (task) =>
          task.id === "benchmark.shanghai.daily" &&
          task.provider === "eastmoney",
      )!
      .run();
    expect(result.data.rows).toHaveLength(60);
    expect(result.data.rows.at(-1)!.date).toBe("2026-10-26");
    const failure = new Error("source transport unavailable");
    get.mockRejectedValue(failure);
    await expect(
      tasks
        .find(
          (task) =>
            task.id === "benchmark.shanghai.daily" &&
            task.provider === "eastmoney",
        )!
        .run(),
    ).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
