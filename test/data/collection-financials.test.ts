import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createChinaFinancialTasks } from "../../src/data/collection-financials.js";
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
function row(extra: Record<string, unknown> = {}) {
  return {
    SECUCODE: "002594.SZ",
    REPORT_DATE: "2026-06-30 00:00:00",
    NOTICE_DATE: "2026-08-29 00:00:00",
    CURRENCY: "CNY",
    ...extra,
  };
}
function response(rows = [row()]) {
  return {
    success: true,
    code: 0,
    result: { pages: 8, count: 80, data: rows },
  };
}
function setup(body: unknown, selectedScope = scope) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(JSON.stringify(body));
  return { get, tasks: createChinaFinancialTasks(http, selectedScope) };
}
afterEach(() => vi.restoreAllMocks());

describe("deterministic China financial collection", () => {
  it("declares the five fixed datasets without requesting anything at construction", () => {
    const { get, tasks } = setup({});
    expect(tasks.map((task) => task.id)).toEqual([
      "financial.indicators",
      "financial.quarter",
      "financial.income",
      "financial.balance",
      "financial.cashflow",
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(
      tasks.every(
        (task) => task.provider === "eastmoney" && task.fallback === undefined,
      ),
    ).toBe(true);
  });

  it("fetches the bounded reporting-period endpoint and preserves direct EPS, ratio, margin and growth values", async () => {
    const { get, tasks } = setup(
      response([
        row({
          EPSJB: 1.35,
          BPS: 26.320758965638,
          MGJYXJJE: 4.094980058566,
          TOTALOPERATEREVE: 344815421000,
          PARENTNETPROFIT: 12325408000,
          ROEJQ: 4.86,
          XSMLL: 18.8473478975,
          LD: 0.870533531674,
          SD: 0.490837000041,
          ZCFZL: 70.9574969499,
          TOTALOPERATEREVETZ: -7.128167265938,
        }),
      ]),
    );
    const result = await tasks[0]!.run();
    expect(get).toHaveBeenCalledTimes(1);
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://datacenter.eastmoney.com/securities/api/data/get",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      type: "RPT_F10_FINANCE_MAINFINADATA",
      sty: "APP_F10_MAINFINADATA",
      ps: "12",
      p: "1",
      st: "REPORT_DATE",
      sr: "-1",
    });
    expect(url.searchParams.get("filter")).toContain('(SECUCODE="002594.SZ")');
    expect(url.searchParams.get("filter")).toContain(
      "(NOTICE_DATE<='2026-10-27')",
    );
    expect(result.data.rows[0]).toMatchObject({
      date: "2026-06-30",
      periodStart: "2026-01-01",
      publishedDate: "2026-08-29",
      availableAt: null,
      values: {
        EPSJB: 1.35,
        BPS: 26.320758965638,
        ZCFZL: 70.9574969499,
        LD: 0.870533531674,
        TOTALOPERATEREVETZ: -7.128167265938,
      },
    });
    expect(result.data.columns.EPSJB!.unit).toBe("CNY/share");
    expect(result.data.columns.ZCFZL!.unit).toBe("percent");
    expect(result.data.columns.LD!.unit).toBe("ratio");
    expect(result.historicalKnowledge).toBe("unverified");
  });

  it("keeps the single-quarter source values separate from cumulative reports", async () => {
    const { tasks, get } = setup(
      response([
        row({
          NOTICE_DATE: undefined,
          TOTALOPERATEREVE: 194590107000,
          PARENTNETPROFIT: 8240857000,
          EPSJB: 0.9,
          GROSS_PROFIT_RATIO: 20.1,
        }),
      ]),
    );
    const result = await tasks[1]!.run();
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams.get("reportName"),
    ).toBe("RPT_F10_QTR_MAINFINADATA");
    expect(result.data.basis).toBe("single_quarter");
    expect(result.data.rows[0]).toMatchObject({
      periodStart: "2026-04-01",
      publishedDate: null,
      values: {
        TOTALOPERATEREVE: 194590107000,
        PARENTNETPROFIT: 8240857000,
        GROSS_PROFIT_RATIO: 20.1,
      },
    });
    expect(
      result.gaps.some((gap) => gap.field === "/data/rows/publishedDate"),
    ).toBe(true);
  });

  it("requests only declared financial fields in the three statement summaries", async () => {
    const { tasks, get } = setup(
      response([
        row({
          TOTAL_ASSETS: 1000,
          TOTAL_LIABILITIES: 200,
          DEBT_ASSET_RATIO: 70.95,
          CURRENT_RATIO: 87.0533531674,
          NETCASH_OPERATE: 37334939900,
        }),
      ]),
    );
    const balance = await tasks[3]!.run();
    const balanceUrl = new URL(String(get.mock.calls[0]![0]));
    expect(balanceUrl.searchParams.get("reportName")).toBe(
      "RPT_DMSK_FN_BALANCE",
    );
    expect(balanceUrl.searchParams.get("columns")).toContain("TOTAL_ASSETS");
    expect(balanceUrl.searchParams.get("columns")).not.toBe("ALL");
    expect(balanceUrl.searchParams.get("columns")).not.toContain(
      "CURRENT_RATIO",
    );
    expect(balance.data.columns).not.toHaveProperty("CURRENT_RATIO");
    expect(balance.data.rows[0]!.values).not.toHaveProperty("CURRENT_RATIO");
    expect(balance.data.basis).toBe("point_in_time");
    expect(balance.data.rows[0]).toMatchObject({
      periodStart: "2026-06-30",
      values: {
        TOTAL_ASSETS: 1000,
        TOTAL_LIABILITIES: 200,
        DEBT_ASSET_RATIO: 70.95,
      },
    });
    const cashflow = await tasks[4]!.run();
    expect(cashflow.data.rows[0]!.values.NETCASH_OPERATE).toBe(37334939900);
    expect(cashflow.data.columns.NETCASH_OPERATE!.unit).toBe("CNY");
    expect(cashflow.data.basis).toBe("year_to_date");
  });

  it("excludes periods and announcements beyond cutoff before passing data to analysis", async () => {
    const { tasks } = setup(
      response([
        row({
          REPORT_DATE: "2026-03-31 00:00:00",
          NOTICE_DATE: "2026-04-29 00:00:00",
          EPSJB: 0.45,
        }),
        row({
          REPORT_DATE: "2026-06-30 00:00:00",
          NOTICE_DATE: "2026-10-28 00:00:00",
          EPSJB: 1.35,
        }),
        row({
          REPORT_DATE: "2026-12-31 00:00:00",
          NOTICE_DATE: "2027-03-28 00:00:00",
          EPSJB: 2,
        }),
      ]),
    );
    const result = await tasks[0]!.run();
    expect(result.data.rows.map((item) => item.date)).toEqual(["2026-03-31"]);
    expect(result.data.rows[0]!.values.EPSJB).toBe(0.45);
  });

  it("returns at most the latest twelve eligible source periods in chronological order", async () => {
    const periods = Array.from({ length: 14 }, (_, index) => {
      const year = 2023 + Math.floor(index / 4);
      const suffix = ["03-31", "06-30", "09-30", "12-31"][index % 4];
      return row({
        REPORT_DATE: `${year}-${suffix} 00:00:00`,
        NOTICE_DATE: null,
        EPSJB: index,
      });
    });
    const { tasks } = setup(response(periods.reverse()));
    const result = await tasks[0]!.run();
    expect(result.data.rows).toHaveLength(12);
    expect(result.data.rows[0]!.date).toBe("2023-09-30");
    expect(result.data.rows.at(-1)!.date).toBe("2026-06-30");
  });

  it("does not substitute zero for missing source quantities", async () => {
    const { tasks } = setup(response([row({ EPSJB: null, ZCFZL: 0 })]));
    const result = await tasks[0]!.run();
    expect(result.data.rows[0]!.values.EPSJB).toBeNull();
    expect(result.data.rows[0]!.values.ZCFZL).toBe(0);
    expect(
      result.gaps.some(
        (gap) =>
          gap.field === "/data/rows/0/values/EPSJB" && gap.code === "missing",
      ),
    ).toBe(true);
  });

  it.each([
    { SECUCODE: "600519.SH" },
    { CURRENCY: "USD" },
    { REPORT_DATE: "2026-05-31 00:00:00" },
    { NOTICE_DATE: "2026-05-01 00:00:00" },
    { EPSJB: "unknown" },
  ])("rejects invalid external financial records: %j", async (extra) => {
    const { tasks } = setup(response([row(extra)]));
    await expect(tasks[0]!.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("rejects duplicate reporting periods rather than silently selecting a revision", async () => {
    const { tasks } = setup(response([row(), row()]));
    await expect(tasks[0]!.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("propagates a transport error without retries or cross-source requests", async () => {
    const { tasks, get } = setup({});
    const failure = new Error("financial source unavailable");
    get.mockRejectedValue(failure);
    await expect(tasks[0]!.run()).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
