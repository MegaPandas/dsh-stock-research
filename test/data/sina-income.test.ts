import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SinaIncomeQuery } from "../../src/contracts/sina-income.js";
import { SinaIncomeAdapter } from "../../src/data/sina-income.js";
import { HttpClient, HttpStatusError } from "../../src/data/http.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const sample = JSON.parse(
  readFileSync(
    new URL("../fixtures/sources/sina-income-600519.json", import.meta.url),
    "utf8",
  ),
);

function query(overrides: Partial<SinaIncomeQuery> = {}): SinaIncomeQuery {
  return {
    scope: {
      security: CN_SECURITY,
      date: "2026-10-25",
      cutoff: "2026-10-25T06:19:04.046Z",
    },
    fields: [
      "revenue",
      "totalOperatingRevenue",
      "netIncome",
      "netIncomeToParent",
    ],
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

function response(
  reportOverrides: Record<string, unknown> = {},
  date = "20260630",
) {
  return {
    result: {
      status: { code: 0 },
      data: {
        report_count: "103",
        report_date: [{ date_value: date }],
        report_list: {
          [date]: {
            ...sample.result.data.report_list["20260630"],
            ...reportOverrides,
          },
        },
      },
    },
  };
}

function item(
  item_field: string,
  item_value: unknown,
  item_title = "unrelated title",
) {
  return { item_field, item_value, item_title };
}

function setup(body: unknown = sample) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(JSON.stringify(body));
  return { adapter: new SinaIncomeAdapter(http), get };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Sina latest income", () => {
  it("preserves the sampled consolidated half-year yuan amounts and distinct source dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T06:20:00.000Z"));
    const { adapter } = setup();
    const result = await adapter.query(query());
    expect(result.data).toEqual({
      currency: "CNY",
      basis: "year_to_date",
      consolidation: "consolidated",
      fields: query().fields,
      observations: [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-06-30",
          publishDate: "2026-08-15",
          sourceUpdatedAt: "2026-08-14T12:50:10.000Z",
          availableAt: null,
          values: {
            revenue: 90_703_260_964.48,
            totalOperatingRevenue: 92_278_072_083.21,
            netIncome: 46_033_330_566.78,
            netIncomeToParent: 44_516_880_421.86,
          },
        },
      ],
    });
    expect(result).toMatchObject({
      dataset: "fundamentals",
      asOf: "2026-06-30T15:59:59.999Z",
      retrievedAt: "2026-10-25T06:20:00.000Z",
      cutoff: query().scope.cutoff,
      availableAt: null,
      historicalKnowledge: "unverified",
      stale: true,
    });
    expect(result.ageMs).toBe(
      Date.parse(query().scope.cutoff) - Date.parse("2026-06-30T15:59:59.999Z"),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ code: "unverified_time" }),
    );
  });

  it.each([
    [CN_SECURITY, "sh600519"],
    [
      {
        ...CN_SECURITY,
        id: "CN:000001.SZ",
        symbol: "000001.SZ",
        exchange: "SZ",
      },
      "sz000001",
    ],
  ])(
    "requests one latest statement for the declared security and forwards cancellation",
    async (security, paperCode) => {
      const { adapter, get } = setup();
      const signal = new AbortController().signal;
      const result = await adapter.query(
        query({ scope: { ...query().scope, security }, fields: ["netIncome"] }),
        signal,
      );
      expect(get).toHaveBeenCalledTimes(1);
      const [input, options] = get.mock.calls[0]!;
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        paperCode,
        source: "lrb",
        type: "0",
        page: "1",
        num: "1",
      });
      expect(options?.signal).toBe(signal);
      expect(result.data.fields).toEqual(["netIncome"]);
      expect(result.data.observations[0]!.values).toEqual({
        netIncome: 46_033_330_566.78,
      });
    },
  );

  it("selects stable field identifiers despite misleading titles and retains zero and losses", async () => {
    const { adapter } = setup(
      response({
        data: [
          item("NETPROFIT", "-42.25", "营业收入"),
          item("BIZINCO", "0", "净利润"),
          item("PARENETP", "-40"),
          item("UNSELECTED", "not a number"),
        ],
      }),
    );
    const result = await adapter.query(
      query({ fields: ["revenue", "netIncome", "netIncomeToParent"] }),
    );
    expect(result.data.observations[0]!.values).toEqual({
      revenue: 0,
      netIncome: -42.25,
      netIncomeToParent: -40,
    });
  });

  it("marks absent amounts and unknown dates without inferring availability", async () => {
    const { adapter } = setup(
      response({
        publish_date: null,
        update_time: undefined,
        data: [item("BIZINCO", null)],
      }),
    );
    const result = await adapter.query(
      query({ fields: ["revenue", "netIncome"] }),
    );
    expect(result.data.observations[0]).toMatchObject({
      publishDate: null,
      sourceUpdatedAt: null,
      availableAt: null,
      values: { revenue: null, netIncome: null },
    });
    for (const field of [
      "/data/observations/0/publishDate",
      "/data/observations/0/sourceUpdatedAt",
      "/data/observations/0/values/revenue",
      "/data/observations/0/values/netIncome",
    ]) {
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ code: "missing", field }),
      );
    }
  });

  it("uses the Shanghai publication day and accepts an update exactly at cutoff", async () => {
    const { adapter } = setup(response({ update_time: null }));
    await expect(
      adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2026-08-15",
            cutoff: "2026-08-14T16:00:00.000Z",
          },
        }),
      ),
    ).resolves.toHaveProperty("data.observations.length", 1);
    const updated = setup(response({ publish_date: null }));
    await expect(
      updated.adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2026-08-14",
            cutoff: "2026-08-14T12:50:10.000Z",
          },
        }),
      ),
    ).resolves.toHaveProperty("data.observations.length", 1);
  });

  it.each([
    [response({ update_time: null }), "2026-08-14", "2026-08-14T15:59:59.999Z"],
    [
      response({ publish_date: null }),
      "2026-08-14",
      "2026-08-14T12:50:09.999Z",
    ],
    [
      response({ publish_date: null, update_time: null }),
      "2026-06-30",
      "2026-06-30T15:59:59.998Z",
    ],
  ])(
    "rejects a latest report beyond cutoff without fetching historical pages",
    async (body, date, cutoff) => {
      const { adapter, get } = setup(body);
      await expect(
        adapter.query(
          query({ scope: { security: CN_SECURITY, date, cutoff } }),
        ),
      ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a strict staleness threshold", async () => {
    const { adapter } = setup();
    const age =
      Date.parse(query().scope.cutoff) - Date.parse("2026-06-30T15:59:59.999Z");
    expect((await adapter.query(query({ maxAgeMs: age }))).stale).toBe(false);
    expect((await adapter.query(query({ maxAgeMs: age - 1 }))).stale).toBe(
      true,
    );
  });

  it.each([
    response({ rCurrency: "USD" }),
    response({ rType: "母公司期末" }),
    response({}, "20260230"),
    response({}, "20260731"),
    response({}, "2026-06-30"),
    response({ publish_date: "20260629" }),
    response({ publish_date: "20260832" }),
    response({ update_time: "1786711810" }),
    response({ update_time: 1.5 }),
    response({ data: [item("BIZINCO", 42)] }),
    response({ data: [item("BIZINCO", "1e3")] }),
    response({ data: [item("BIZINCO", "9".repeat(400))] }),
    response({ data: [item("BIZINCO", "1"), item("BIZINCO", "2")] }),
  ])("rejects malformed source contracts without retrying", async (body) => {
    const { adapter, get } = setup(body);
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(["extra", "mismatch"])(
    "rejects %s report indexes rather than choosing a report",
    async (kind) => {
      const body = response();
      const reports = body.result.data.report_list;
      if (kind === "extra") {
        reports["20260331"] = reports["20260630"]!;
        body.result.data.report_date.push({ date_value: "20260331" });
      } else {
        reports["20260331"] = reports["20260630"]!;
        delete reports["20260630"];
      }
      const { adapter, get } = setup(body);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("reports an empty latest view as insufficient", async () => {
    const { adapter, get } = setup({
      result: {
        status: { code: 0 },
        data: { report_date: [], report_list: {} },
      },
    });
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retains API failure details as cause", async () => {
    const body = {
      result: { status: { code: 500, msg: "failure" }, data: null },
    };
    const { adapter, get } = setup(body);
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      cause: body,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("offline"),
    new HttpStatusError(new Response(null, { status: 429 })),
    new DOMException("cancelled", "AbortError"),
  ])(
    "propagates transport and cancellation errors unchanged",
    async (error) => {
      const { adapter, get } = setup();
      get.mockRejectedValue(error);
      await expect(adapter.query(query())).rejects.toBe(error);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    US_SECURITY,
    { ...CN_SECURITY, exchange: "BJ" },
    { ...CN_SECURITY, currency: "USD" },
  ])("rejects unsupported capabilities before GET", async (security) => {
    const { adapter, get } = setup();
    await expect(
      adapter.query(query({ scope: { ...query().scope, security } })),
    ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
    expect(get).not.toHaveBeenCalled();
  });
});
