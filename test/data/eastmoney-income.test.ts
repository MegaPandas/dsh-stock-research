import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EastmoneyIncomeQuery } from "../../src/contracts/eastmoney-income.js";
import { EastmoneyIncomeAdapter } from "../../src/data/eastmoney-income.js";
import { HttpClient, HttpStatusError } from "../../src/data/http.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const sample = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/sources/eastmoney-income-600519.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const realRow = sample.result.data[0] as Record<string, unknown>;

function row(overrides: Record<string, unknown> = {}) {
  return { ...realRow, ...overrides };
}

function response(rows = [row()], metadata: Record<string, unknown> = {}) {
  return {
    success: true,
    code: 0,
    result: { pages: 1, count: rows.length, data: rows, ...metadata },
  };
}

function query(
  overrides: Partial<EastmoneyIncomeQuery> = {},
): EastmoneyIncomeQuery {
  return {
    scope: {
      security: CN_SECURITY,
      date: "2025-05-01",
      cutoff: "2025-05-01T15:59:59.999Z",
    },
    fields: ["totalOperatingRevenue", "netIncomeToParent"],
    periodEndFrom: "2024-03-31",
    periodEndTo: "2024-03-31",
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

function setup(body: unknown = sample) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(JSON.stringify(body));
  return { adapter: new EastmoneyIncomeAdapter(http), get };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Eastmoney income", () => {
  it("preserves sampled yuan amounts and the later announcement without claiming historical availability", async () => {
    const { adapter } = setup();
    const result = await adapter.query(query());
    expect(result.data).toEqual({
      currency: "CNY",
      basis: "year_to_date",
      fields: ["totalOperatingRevenue", "netIncomeToParent"],
      observations: [
        {
          periodStart: "2024-01-01",
          periodEnd: "2024-03-31",
          noticeDate: "2025-04-30",
          availableAt: null,
          values: {
            totalOperatingRevenue: 46_484_738_134.23,
            netIncomeToParent: 24_065_262_374.15,
          },
        },
      ],
    });
    expect(result).toMatchObject({
      asOf: "2024-03-31T15:59:59.999Z",
      availableAt: null,
      historicalKnowledge: "unverified",
      stale: true,
    });
    expect(result.ageMs).toBe(
      Date.parse(query().scope.cutoff) - Date.parse("2024-03-31T15:59:59.999Z"),
    );
    await expect(
      adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2024-05-01",
            cutoff: "2024-05-01T15:59:59.999Z",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });

  it.each([
    ["totalOperatingRevenue", "TOTAL_OPERATE_INCOME"],
    ["netIncomeToParent", "PARENT_NETPROFIT"],
  ] as const)(
    "requests only %s once and forwards cancellation",
    async (field, column) => {
      const { adapter, get } = setup();
      const signal = new AbortController().signal;
      const result = await adapter.query(query({ fields: [field] }), signal);
      expect(get).toHaveBeenCalledTimes(1);
      const [input, options] = get.mock.calls[0]!;
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
      );
      expect(url.searchParams.get("reportName")).toBe("RPT_DMSK_FN_INCOME");
      expect(url.searchParams.get("columns")?.split(",")).toEqual([
        "SECUCODE",
        "REPORT_DATE",
        "NOTICE_DATE",
        column,
      ]);
      expect(url.searchParams.get("filter")).toContain("600519.SH");
      expect(url.searchParams.get("filter")).toContain("2024-03-31");
      expect(url.searchParams.get("pageNumber")).toBe("1");
      expect(url.searchParams.get("pageSize")).toBe("1");
      expect(options?.signal).toBe(signal);
      expect(Object.keys(result.data.observations[0]!.values)).toEqual([field]);
    },
  );

  it("sorts cumulative periods without turning half-year values into a quarter", async () => {
    const { adapter, get } = setup(
      response([
        row({
          REPORT_DATE: "2024-06-30 00:00:00",
          NOTICE_DATE: "2024-08-01 00:00:00",
          TOTAL_OPERATE_INCOME: 300,
        }),
        row({ NOTICE_DATE: "2024-04-30 00:00:00", TOTAL_OPERATE_INCOME: 100 }),
      ]),
    );
    const result = await adapter.query(query({ periodEndTo: "2024-06-30" }));
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.searchParams.get("filter")).toBe(
      "(SECUCODE=\"600519.SH\")(REPORT_DATE>='2024-03-31')(REPORT_DATE<='2024-06-30')",
    );
    expect(url.searchParams.get("pageSize")).toBe("2");
    expect(
      result.data.observations.map(({ periodStart, periodEnd, values }) => [
        periodStart,
        periodEnd,
        values.totalOperatingRevenue,
      ]),
    ).toEqual([
      ["2024-01-01", "2024-03-31", 100],
      ["2024-01-01", "2024-06-30", 300],
    ]);
  });

  it("uses the Shanghai cutoff day for announcements and requires period day completion", async () => {
    const { adapter } = setup(
      response([row({ NOTICE_DATE: "2025-05-01 00:00:00" })]),
    );
    await expect(
      adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2025-05-01",
            cutoff: "2025-04-30T16:00:00.000Z",
          },
        }),
      ),
    ).resolves.toHaveProperty("data.observations.length", 1);
    await expect(
      adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2025-04-30",
            cutoff: "2025-04-30T15:59:59.999Z",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    const current = setup(response([row({ NOTICE_DATE: null })]));
    await expect(
      current.adapter.query(
        query({
          scope: {
            security: CN_SECURITY,
            date: "2024-03-31",
            cutoff: "2024-03-31T15:59:59.998Z",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });

  it("retains zero and losses, while marking missing amounts and announcements at their JSON pointers", async () => {
    const { adapter } = setup(
      response([
        row({
          NOTICE_DATE: null,
          TOTAL_OPERATE_INCOME: 0,
          PARENT_NETPROFIT: -42,
        }),
        row({
          REPORT_DATE: "2024-06-30 00:00:00",
          NOTICE_DATE: undefined,
          TOTAL_OPERATE_INCOME: null,
          PARENT_NETPROFIT: undefined,
        }),
      ]),
    );
    const result = await adapter.query(query({ periodEndTo: "2024-06-30" }));
    expect(result.data.observations.map(({ values }) => values)).toEqual([
      { totalOperatingRevenue: 0, netIncomeToParent: -42 },
      { totalOperatingRevenue: null, netIncomeToParent: null },
    ]);
    for (const field of [
      "/data/observations/0/noticeDate",
      "/data/observations/1/noticeDate",
      "/data/observations/1/values/totalOperatingRevenue",
      "/data/observations/1/values/netIncomeToParent",
    ]) {
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ code: "missing", field }),
      );
    }
  });

  it("marks staleness only strictly beyond maxAgeMs", async () => {
    const { adapter } = setup();
    const age =
      Date.parse(query().scope.cutoff) - Date.parse("2024-03-31T15:59:59.999Z");
    expect((await adapter.query(query({ maxAgeMs: age }))).stale).toBe(false);
    expect((await adapter.query(query({ maxAgeMs: age - 1 }))).stale).toBe(
      true,
    );
  });

  it.each([
    response([row({ SECUCODE: "000001.SZ" })]),
    response([row({ REPORT_DATE: "2024-02-30 00:00:00" })]),
    response([row({ REPORT_DATE: "2024-04-30 00:00:00" })]),
    response([row({ REPORT_DATE: "2024-03-31" })]),
    response([row({ NOTICE_DATE: "2024-03-30 00:00:00" })]),
    response([row({ NOTICE_DATE: "invalid" })]),
    response([row({ TOTAL_OPERATE_INCOME: "42" })]),
    response([row(), row()]),
    response([row()], { pages: 2, count: 2 }),
    response([row()], { count: 2 }),
  ])(
    "rejects malformed or incomplete source data without retrying",
    async (body) => {
      const { adapter, get } = setup(body);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects non-finite JSON amounts", async () => {
    const { adapter, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(response([row({ PARENT_NETPROFIT: 123456789 })])).replace(
        "123456789",
        "1e400",
      ),
    );
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps API failure details as the cause", async () => {
    const body = {
      success: false,
      code: 500,
      message: "source failure",
      result: null,
    };
    const { adapter, get } = setup(body);
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      cause: body,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reports an empty result as insufficient", async () => {
    const { adapter, get } = setup(response([]));
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("offline"),
    new HttpStatusError(new Response(null, { status: 429 })),
  ])("propagates transport failures without retrying", async (error) => {
    const { adapter, get } = setup();
    get.mockRejectedValue(error);
    await expect(adapter.query(query())).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    US_SECURITY,
    { ...CN_SECURITY, exchange: "BJ" },
    { ...CN_SECURITY, currency: "USD" },
  ])("rejects unsupported capabilities before requesting", async (security) => {
    const { adapter, get } = setup();
    await expect(
      adapter.query(query({ scope: { ...query().scope, security } })),
    ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
    expect(get).not.toHaveBeenCalled();
  });
});
