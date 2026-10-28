import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createChinaFinancialTasks } from "../../src/data/collection-financials.js";
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
function row(extra: Record<string, unknown> = {}) {
  return {
    report_date: Date.parse("2026-06-30T00:00:00+08:00"),
    report_name: "2026中报",
    ctime: Date.parse("2026-08-29T08:00:00+08:00"),
    ...extra,
  };
}
function setup(
  rows: Record<string, unknown>[] = [row()],
  selectedScope = scope,
  currency = "CNY",
) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  vi.spyOn(http, "getText").mockResolvedValue(
    JSON.stringify({ error_code: 0, data: { currency, list: rows } }),
  );
  const client = new XueqiuClient(http, "session=fixture");
  const get = vi.spyOn(client, "get");
  return {
    get,
    tasks: createChinaFinancialTasks(http, selectedScope, client),
    withoutXueqiu: createChinaFinancialTasks(http, selectedScope),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("Xueqiu financial collection fallback", () => {
  it("adds four lazy fallbacks while leaving the single-quarter table and default tasks unchanged", () => {
    const { tasks, withoutXueqiu, get } = setup();
    expect(tasks.map((task) => [task.id, task.fallback?.provider])).toEqual([
      ["financial.indicators", "xueqiu"],
      ["financial.quarter", undefined],
      ["financial.income", "xueqiu"],
      ["financial.balance", "xueqiu"],
      ["financial.cashflow", "xueqiu"],
    ]);
    expect(tasks.every((task) => task.provider === "eastmoney")).toBe(true);
    expect(withoutXueqiu.every((task) => task.fallback === undefined)).toBe(
      true,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps source principal values and percent units without deriving missing indicators", async () => {
    const { tasks, get } = setup([
      row({
        basic_eps: [1.35, 0.08],
        np_per_share: [26.32, 0.12],
        total_revenue: [344815421000, 0.18],
        net_profit_atsopc: [12325408000, 0.21],
        net_profit_atsopc_yoy: [21, 0.36],
        avg_roe: [4.86, 0.23],
        gross_selling_rate: [18.84, 0.16],
        current_ratio: [0.87, 0.03],
        asset_liab_ratio: [70.95, 0.05],
        operating_income_yoy: [18, 0.2],
      }),
    ]);
    const signal = new AbortController().signal;
    const result = await tasks[0]!.fallback!.run(signal);
    expect(get).toHaveBeenCalledWith(
      "/v5/stock/finance/cn/indicator.json",
      {
        symbol: "SZ002594",
        type: "all",
        is_detail: "true",
        count: "12",
        timestamp: String(Date.parse(scope.cutoff)),
      },
      signal,
    );
    expect(result.source.provider).toBe("xueqiu");
    expect(result.data.basis).toBe("year_to_date");
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-06-30",
      periodStart: "2026-01-01",
      publishedDate: null,
      availableAt: null,
      values: {
        EPSJB: 1.35,
        BPS: 26.32,
        TOTALOPERATEREVE: 344815421000,
        PARENTNETPROFIT: 12325408000,
        PARENTNETPROFITTZ: 21,
        ROEJQ: 4.86,
        XSMLL: 18.84,
        LD: 0.87,
        ZCFZL: 70.95,
        MLR: null,
        TOTALOPERATEREVETZ: null,
      },
    });
    expect(result.data.columns.LD!.unit).toBe("ratio");
    expect(result.data.columns.XSMLL!.unit).toBe("percent");
    expect(result.historicalKnowledge).toBe("unverified");
    expect(result.gaps).toContainEqual({
      code: "missing",
      field: "/data/rows/0/values/MLR",
      detail: "毛利润 is absent for 2026-06-30.",
    });
    expect(
      result.gaps.some((gap) => gap.field === "/data/rows/publishedDate"),
    ).toBe(true);
  });

  it("keeps revenue and total revenue, and parent and total net profit distinct", async () => {
    const { tasks } = setup([
      row({
        total_revenue: [500, 0.05],
        revenue: [450, 0.04],
        operating_costs: [400, 0.03],
        operating_cost: [350, 0.02],
        net_profit: [75, 0.2],
        net_profit_atsopc: [60, 0.1],
        net_profit_after_nrgal_atsolc: [55, 0.08],
      }),
    ]);
    const result = await tasks[2]!.fallback!.run();
    expect(result.data.rows[0]!.values).toMatchObject({
      TOTAL_OPERATE_INCOME: 500,
      OPERATE_INCOME: 450,
      TOTAL_OPERATE_COST: 400,
      OPERATE_COST: 350,
      PARENT_NETPROFIT: 60,
      DEDUCT_PARENT_NETPROFIT: 55,
    });
    expect(result.data.basis).toBe("year_to_date");
  });

  it("preserves point-in-time balances and cumulative cash flows without monetary scaling", async () => {
    const { tasks } = setup([
      row({
        total_assets: [1000, 0.2],
        total_liab: [700, 0.1],
        asset_liab_ratio: [70, 0.05],
        ncf_from_oa: [150, 0.15],
        ncf_from_ia: [-50, 0.1],
        ncf_from_fa: [-20, 0.3],
        net_increase_in_cce: [80, 0.4],
      }),
    ]);
    const balance = await tasks[3]!.fallback!.run();
    expect(balance.data.basis).toBe("point_in_time");
    expect(balance.data.rows[0]).toMatchObject({
      periodStart: "2026-06-30",
      values: {
        TOTAL_ASSETS: 1000,
        TOTAL_LIABILITIES: 700,
        DEBT_ASSET_RATIO: 70,
      },
    });
    const cashflow = await tasks[4]!.fallback!.run();
    expect(cashflow.data.basis).toBe("year_to_date");
    expect(cashflow.data.rows[0]).toMatchObject({
      periodStart: "2026-01-01",
      values: {
        NETCASH_OPERATE: 150,
        NETCASH_INVEST: -50,
        NETCASH_FINANCE: -20,
        CCE_ADD: 80,
      },
    });
    expect(cashflow.data.columns.NETCASH_OPERATE!.unit).toBe("CNY");
  });

  it("preserves missing and zero values independently of the comparison value", async () => {
    const { tasks } = setup([
      row({ basic_eps: [null, 5], avg_roe: [0, 8], current_ratio: null }),
    ]);
    const result = await tasks[0]!.fallback!.run();
    expect(result.data.rows[0]!.values).toMatchObject({
      EPSJB: null,
      ROEJQ: 0,
      LD: null,
      SD: null,
    });
  });

  it("excludes future reporting periods and keeps source creation time unverified", async () => {
    const { tasks } = setup([
      row({
        report_date: Date.parse("2026-12-31T00:00:00+08:00"),
        basic_eps: [8, 1],
      }),
      row({ basic_eps: [1.35, 1], ctime: Date.parse("2030-01-01T00:00:00Z") }),
    ]);
    const result = await tasks[0]!.fallback!.run();
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-06-30",
      availableAt: null,
      publishedDate: null,
      values: { EPSJB: 1.35 },
    });
  });

  it("limits the result to the latest twelve eligible reporting periods", async () => {
    const rows = Array.from({ length: 14 }, (_, index) => {
      const year = 2023 + Math.floor(index / 4);
      const day = ["03-31", "06-30", "09-30", "12-31"][index % 4];
      return row({
        report_date: Date.parse(`${year}-${day}T00:00:00+08:00`),
        basic_eps: [index, 0],
      });
    });
    const { tasks } = setup(rows.reverse());
    const result = await tasks[0]!.fallback!.run();
    expect(result.data.rows).toHaveLength(12);
    expect(result.data.rows[0]!.date).toBe("2023-09-30");
    expect(result.data.rows.at(-1)!.date).toBe("2026-06-30");
  });

  it.each([
    { report_date: Date.parse("2026-05-31T00:00:00+08:00") },
    { report_date: "2026-06-30" },
    { basic_eps: 1.35 },
    { basic_eps: [] },
    { basic_eps: [1, 2, 3] },
    { basic_eps: ["unknown", 0] },
  ])("rejects invalid source fields: %j", async (extra) => {
    const { tasks } = setup([row(extra)]);
    await expect(tasks[0]!.fallback!.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("rejects a non-CNY response and duplicate reporting periods", async () => {
    const { tasks } = setup([row()], scope, "USD");
    await expect(tasks[0]!.fallback!.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    const duplicate = setup([row(), row()]);
    await expect(duplicate.tasks[2]!.fallback!.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});
