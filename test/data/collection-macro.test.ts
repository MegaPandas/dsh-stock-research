import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createChinaMacroTasks } from "../../src/data/collection-macro.js";
import { HttpClient } from "../../src/data/http.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope: ResearchScope = {
  security: CN_SECURITY,
  date: "2026-10-27",
  cutoff: "2026-10-27T04:00:00.000Z",
};
const response = (data: Record<string, unknown>[], pages = 1) =>
  JSON.stringify({ success: true, result: { data, pages } });

function setup(text = response([]), selectedScope = scope) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(text);
  vi.spyOn(http, "forSource").mockReturnValue(http);
  const tasks = createChinaMacroTasks(http, selectedScope);
  const task = (id: string) => tasks.find((item) => item.id === id)!;
  return { http, get, tasks, task };
}

afterEach(() => vi.restoreAllMocks());

describe("fixed China macro collection", () => {
  it("defines one source per dataset and no research or fallback requests", () => {
    const { tasks, get } = setup();
    expect(
      tasks.map(({ id, dataset, provider, enabledBy }) => ({
        id,
        dataset,
        provider,
        enabledBy,
      })),
    ).toEqual(
      [
        "gdp",
        "cpi",
        "ppi",
        "pmi",
        "moneySupply",
        "lpr",
        "industrial",
        "retail",
        "investment",
        "trade",
        "socialFinancing",
      ].map((name) => ({
        id: `macro.${name}`,
        dataset: "macro",
        provider: name === "socialFinancing" ? "mofcom" : "eastmoney",
        enabledBy: ["china-macro"],
      })),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("requests twelve completed quarters and keeps GDP as year-to-date source values", async () => {
    const { task, get } = setup(
      response([
        {
          REPORT_DATE: "2026-09-01 00:00:00",
          DOMESTICL_PRODUCT_BASE: 1071071.2,
          SUM_SAME: 4.6,
        },
        {
          REPORT_DATE: "2023-12-01 00:00:00",
          DOMESTICL_PRODUCT_BASE: 1260582.1,
          SUM_SAME: 5.2,
        },
      ]),
    );
    const signal = new AbortController().signal;
    const envelope = await task("macro.gdp").run(signal);
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.searchParams.get("reportName")).toBe("RPT_ECONOMY_GDP");
    expect(url.searchParams.get("pageSize")).toBe("12");
    expect(url.searchParams.get("filter")).toBe(
      "(REPORT_DATE>='2023-10-01')(REPORT_DATE<='2026-09-30')",
    );
    expect(url.searchParams.get("columns")).not.toContain("ALL");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]?.signal).toBe(signal);
    expect(envelope.data.basis).toBe("year_to_date");
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2023-12-01",
      "2026-09-01",
    ]);
    expect(envelope.data.rows.at(-1)).toMatchObject({
      asOf: "2026-09-30T15:59:59.999Z",
      availableAt: null,
      values: { DOMESTICL_PRODUCT_BASE: 1071071.2, SUM_SAME: 4.6 },
    });
    expect(envelope.data.columns.DOMESTICL_PRODUCT_BASE?.unit).toBe("CNY_100m");
    expect(envelope.historicalKnowledge).toBe("unverified");
    expect(envelope.gaps).toContainEqual(
      expect.objectContaining({ code: "unverified_time" }),
    );
  });

  it("keeps M2, M1 and M0 amounts in hundred-million yuan without scaling percentages", async () => {
    const { task } = setup(
      response([
        {
          REPORT_DATE: "2026-09-01",
          BASIC_CURRENCY: "3596289.7",
          BASIC_CURRENCY_SAME: "7.2",
          CURRENCY: 1167563.84,
          CURRENCY_SAME: 3.2,
          FREE_CASH: null,
          FREE_CASH_SAME: "-",
        },
      ]),
    );
    const envelope = await task("macro.moneySupply").run();
    expect(envelope.data.rows[0]!.values).toEqual({
      BASIC_CURRENCY: 3596289.7,
      BASIC_CURRENCY_SAME: 7.2,
      CURRENCY: 1167563.84,
      CURRENCY_SAME: 3.2,
      FREE_CASH: null,
      FREE_CASH_SAME: null,
    });
    expect(envelope.data.columns.BASIC_CURRENCY).toEqual({
      label: "M2余额",
      unit: "CNY_100m",
    });
    expect(envelope.data.columns.CURRENCY).toEqual({
      label: "M1余额",
      unit: "CNY_100m",
    });
    expect(envelope.data.basis).toContain("M1 statistical scope");
    expect(envelope.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/rows/0/values/FREE_CASH",
      }),
    );
  });

  it("filters outside the monthly window and never treats month labels as publication times", async () => {
    const { task, get } = setup(
      response([
        { REPORT_DATE: "2023-09-01", NATIONAL_SAME: 1 },
        { REPORT_DATE: "2023-10-01", NATIONAL_SAME: 0.2 },
        {
          REPORT_DATE: "2026-09-01",
          NATIONAL_SAME: 0.9,
          NATIONAL_BASE: 100.9,
          NATIONAL_SEQUENTIAL: 0.2,
          NATIONAL_ACCUMULATE: 100.9,
        },
        { REPORT_DATE: "2026-10-01", NATIONAL_SAME: 99 },
      ]),
    );
    const envelope = await task("macro.cpi").run();
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2023-10-01",
      "2026-09-01",
    ]);
    expect(envelope.data.rows.at(-1)!.values.NATIONAL_BASE).toBe(100.9);
    expect(envelope.availableAt).toBeNull();
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.searchParams.get("pageSize")).toBe("36");
    expect(url.searchParams.get("filter")).toBe(
      "(REPORT_DATE>='2023-10-01')(REPORT_DATE<='2026-09-30')",
    );
  });

  it("takes LPR from event dates, including a current-month quote, with the original percent unit", async () => {
    const { task, get } = setup(
      response([
        { TRADE_DATE: "2026-10-20 00:00:00", LPR1Y: 3, LPR5Y: 3.5 },
        { TRADE_DATE: "2026-10-28 00:00:00", LPR1Y: 2.9, LPR5Y: 3.4 },
      ]),
    );
    const envelope = await task("macro.lpr").run();
    expect(envelope.data.rows).toHaveLength(1);
    expect(envelope.data.rows[0]).toMatchObject({
      date: "2026-10-20",
      asOf: "2026-10-20T00:00:00.000Z",
      values: { LPR1Y: 3, LPR5Y: 3.5 },
    });
    expect(envelope.data.columns.LPR1Y?.unit).toBe("percent");
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.searchParams.get("reportName")).toBe("RPTA_WEB_RATE");
    expect(url.searchParams.get("sortColumns")).toBe("TRADE_DATE");
  });

  it("uses the shared POST transport for social financing and exposes an old latest period", async () => {
    const { task, http, get } = setup();
    const post = vi.spyOn(http, "postText").mockResolvedValue(
      JSON.stringify([
        { date: "202309", tiosfs: 100 },
        { date: "202604", tiosfs: 6245, rmblaon: -4006 },
        { date: "202603", tiosfs: 50000 },
        { date: "202610", tiosfs: 99999 },
      ]),
    );
    const signal = new AbortController().signal;
    const envelope = await task("macro.socialFinancing").run(signal);
    expect(post).toHaveBeenCalledExactlyOnceWith(
      "https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery",
      { signal },
    );
    expect(get).not.toHaveBeenCalled();
    expect(envelope.data.rows.map((row) => row.date)).toEqual([
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(envelope.data.rows.at(-1)!.values.tiosfs).toBe(6245);
    expect(envelope.data.rows.at(-1)!.values.rmblaon).toBe(-4006);
    expect(envelope.data.columns.tiosfs?.unit).toBe("CNY_100m");
    expect(envelope.stale).toBe(true);
    expect(envelope.gaps).toContainEqual(
      expect.objectContaining({
        code: "stale",
        detail: expect.stringContaining("2026-04"),
      }),
    );
  });

  it("keeps a recently observed social financing period without a stale warning", async () => {
    const { task, http } = setup();
    vi.spyOn(http, "postText").mockResolvedValue(
      JSON.stringify([{ date: "202609", tiosfs: 42000 }]),
    );
    const envelope = await task("macro.socialFinancing").run();
    expect(envelope.stale).toBe(false);
    expect(envelope.gaps.some((gap) => gap.code === "stale")).toBe(false);
  });

  it("only collects verified trade growth units", async () => {
    const { task, get } = setup(
      response([
        {
          REPORT_DATE: "2026-09-01",
          EXIT_BASE: 447184259.939,
          EXIT_BASE_SAME: 36.3,
          IMPORT_BASE_SAME: 31,
        },
      ]),
    );
    const envelope = await task("macro.trade").run();
    expect(envelope.data.rows[0]!.values.EXIT_BASE_SAME).toBe(36.3);
    expect(envelope.data.rows[0]!.values).not.toHaveProperty("EXIT_BASE");
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams
        .get("columns")
        ?.split(","),
    ).not.toContain("EXIT_BASE");
  });

  it("rejects an empty successful response instead of publishing an empty packet", async () => {
    const { task } = setup();
    await expect(task("macro.ppi").run()).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
  });

  it("rejects duplicate dates and incomplete pagination", async () => {
    const duplicate = setup(
      response([{ REPORT_DATE: "2026-09-01" }, { REPORT_DATE: "2026-09-01" }]),
    );
    await expect(duplicate.task("macro.pmi").run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    const paginated = setup(response([{ REPORT_DATE: "2026-09-01" }], 2));
    await expect(paginated.task("macro.pmi").run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it.each([
    { REPORT_DATE: "2026-09-01", NATIONAL_SAME: "not a number" },
    { REPORT_DATE: "2026-99-01", NATIONAL_SAME: 1 },
  ])("rejects malformed external quantities and dates", async (row) => {
    const { task } = setup(response([row]));
    await expect(task("macro.cpi").run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it("propagates source and transport errors without retries", async () => {
    const { task, get } = setup(
      JSON.stringify({ success: false, message: "report unavailable" }),
    );
    await expect(task("macro.cpi").run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    const failure = new Error("connection interrupted");
    get.mockRejectedValueOnce(failure);
    await expect(task("macro.cpi").run()).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("admits a completed current month only once the observation period has ended", async () => {
    const atEnd = {
      ...scope,
      date: "2026-10-31",
      cutoff: "2026-10-31T15:59:59.999Z",
    };
    const { task, get } = setup(
      response([{ REPORT_DATE: "2026-10-01", BASE_SAME: 5 }]),
      atEnd,
    );
    const envelope = await task("macro.industrial").run();
    expect(envelope.data.rows[0]!.date).toBe("2026-10-01");
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams.get("filter"),
    ).toBe("(REPORT_DATE>='2023-11-01')(REPORT_DATE<='2026-10-31')");
  });
});
