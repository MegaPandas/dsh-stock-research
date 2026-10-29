import { describe, expect, it } from "vitest";
import { deriveFinancialMetrics } from "../../src/data/financial-metrics.js";
import type { CollectionPacket } from "../../src/contracts/collection.js";
import { CN_SECURITY } from "../fixtures/market.js";
const scope = {
  security: CN_SECURITY,
  date: "2026-10-01",
  cutoff: "2026-10-01T00:00:00.000Z",
};
function packet(
  id: string,
  data: [string, Record<string, number | null>][],
  unit = "CNY",
): CollectionPacket {
  return {
    id,
    envelope: {
      dataset: "fundamentals",
      data: {
        table: id,
        title: id,
        currency: unit,
        basis: "year_to_date",
        columns: Object.fromEntries(
          Object.keys(data[0]![1]).map((k) => [k, { label: k, unit }]),
        ),
        rows: data.map(([date, values]) => ({
          date,
          periodStart: `${date.slice(0, 4)}-01-01`,
          values,
          asOf: `${date}T00:00:00.000Z`,
          availableAt: null,
          complete: true,
        })),
      },
      source: {
        provider: "fixture",
        url: `urn:${id}`,
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: "2026-06-30T00:00:00.000Z",
      availableAt: null,
      retrievedAt: "2026-09-01T00:00:00.000Z",
      cutoff: scope.cutoff,
      ageMs: 0,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [],
    },
  };
}
describe("snapshot financial metrics", () => {
  it.each(["CNY", "USD"])(
    "calculates TTM FCF from matching cumulative %s statements",
    (unit) => {
      const income = packet(
        "financial.income",
        [
          ["2025-06-30", { PARENT_NETPROFIT: 15510533000 }],
          ["2025-12-31", { PARENT_NETPROFIT: 32619022000 }],
          ["2026-06-30", { PARENT_NETPROFIT: 12325408000 }],
        ],
        unit,
      );
      const cash = packet(
        "financial.cashflow",
        [
          [
            "2025-06-30",
            { NETCASH_OPERATE: 31833471000, CONSTRUCT_LONG_ASSET: 80524516000 },
          ],
          [
            "2025-12-31",
            {
              NETCASH_OPERATE: 59135544000,
              CONSTRUCT_LONG_ASSET: 156807853000,
            },
          ],
          [
            "2026-06-30",
            { NETCASH_OPERATE: 37334744000, CONSTRUCT_LONG_ASSET: 44703066000 },
          ],
        ],
        unit,
      );
      const result = deriveFinancialMetrics(scope, [income, cash])!.envelope;
      const values = result.data.rows.find(
        (r) => r.date === "2026-06-30",
      )!.values;
      expect(values.NET_INCOME_TTM).toBe(29433897000);
      expect(values.OCF_TTM).toBe(64636817000);
      expect(values.CAPEX_TTM).toBe(120986403000);
      expect(values.FREE_CASH_FLOW_TTM).toBe(-56349586000);
      expect(values.NET_INCOME_QUARTER).toBeNull();
      expect(result.data.columns.FREE_CASH_FLOW_TTM!.unit).toBe(unit);
      expect(result).toMatchObject({
        asOf: income.envelope.asOf,
        availableAt: null,
        retrievedAt: income.envelope.retrievedAt,
        stale: true,
        historicalKnowledge: "unverified",
        source: { provider: "stock-research" },
      });
    },
  );
  it("derives quarter independently and rejects zero denominators and missing values", () => {
    const income = packet("financial.income", [
      [
        "2026-03-31",
        { TOTAL_OPERATE_INCOME: 0, PARENT_NETPROFIT: 20, OPERATE_COST: null },
      ],
      [
        "2026-06-30",
        { TOTAL_OPERATE_INCOME: 100, PARENT_NETPROFIT: 50, OPERATE_COST: 60 },
      ],
    ]);
    const result = deriveFinancialMetrics(scope, [income])!.envelope;
    expect(result.data.rows[0]!.values.NET_MARGIN_QUARTER).toBeNull();
    expect(result.data.rows[1]!.values.NET_INCOME_QUARTER).toBe(30);
    expect(result.data.rows[1]!.values.NET_INCOME_TTM).toBeNull();
    expect(result.gaps.some((g) => g.field.includes("NET_INCOME_TTM"))).toBe(
      true,
    );
  });
  it("does not match SEC periods on end date alone", () => {
    const p = packet(
      "financial.revenue",
      [
        ["2025-06-30", { revenue: 5 }],
        ["2025-12-31", { revenue: 100 }],
        ["2026-06-30", { revenue: 30 }],
      ],
      "USD",
    );
    p.envelope.data.rows[0]!.periodStart = "2025-04-01";
    const r = deriveFinancialMetrics(scope, [p])!.envelope.data.rows.find(
      (r) => r.date === "2026-06-30",
    )!;
    expect(r.values.REVENUE_TTM).toBeNull();
    expect(r.values.REVENUE_YOY).toBeNull();
  });
  it("does not combine providers or create market-only empty tables", () => {
    const income = packet("financial.income", [
      ["2026-03-31", { PARENT_NETPROFIT: 10 }],
    ]);
    const cash = packet("financial.cashflow", [
      ["2026-03-31", { NETCASH_OPERATE: 30, CONSTRUCT_LONG_ASSET: 5 }],
    ]);
    cash.envelope.source.provider = "other";
    expect(
      deriveFinancialMetrics(scope, [income, cash])!.envelope.data.rows[0]!
        .values.CASH_CONVERSION_QUARTER,
    ).toBeNull();
    expect(deriveFinancialMetrics(scope, [])).toBeUndefined();
    expect(
      deriveFinancialMetrics(scope, [
        packet("market.daily", [["2026-03-31", { close: 10 }]]),
      ]),
    ).toBeUndefined();
  });
  it("uses reported equity independently of current shares and computes working capital", () => {
    const indicators = packet("financial.indicators", [
      ["2026-06-30", { BPS: 5, TOTALOPERATEREVE: 100, PARENTNETPROFIT: 20 }],
    ]);
    indicators.envelope.data.columns.BPS!.unit = "CNY/share";
    const shares = packet(
      "valuation.history",
      [["2026-09-30", { TOTAL_SHARES: 10 }]],
      "shares",
    );
    const balance = packet("financial.balance", [
      [
        "2026-03-31",
        {
          ACCOUNTS_RECE: 10,
          INVENTORY: 20,
          ACCOUNTS_PAYABLE: 5,
          TOTAL_EQUITY: 80,
          TOTAL_PARENT_EQUITY: 60,
          MINORITY_EQUITY: 20,
        },
      ],
      [
        "2026-06-30",
        {
          ACCOUNTS_RECE: 15,
          INVENTORY: 25,
          ACCOUNTS_PAYABLE: 10,
          TOTAL_EQUITY: 90,
          TOTAL_PARENT_EQUITY: 70,
          MINORITY_EQUITY: 20,
        },
      ],
    ]);
    for (const row of balance.envelope.data.rows) row.periodStart = row.date;
    const result = deriveFinancialMetrics(scope, [
      indicators,
      balance,
      shares,
    ])!.envelope;
    const equity = result.data.rows.find(
      (r) => r.date === "2026-06-30" && r.periodStart === "2026-01-01",
    )!;
    expect(equity.values.TOTAL_PARENT_EQUITY).toBe(70);
    expect(equity.values.MINORITY_EQUITY).toBe(20);
    shares.envelope.data.rows[0]!.values.TOTAL_SHARES = 1000;
    const changed = deriveFinancialMetrics(scope, [
      indicators,
      balance,
      shares,
    ])!.envelope;
    expect(
      changed.data.rows.find(
        (r) => r.date === equity.date && r.periodStart === equity.periodStart,
      )!.values.TOTAL_PARENT_EQUITY,
    ).toBe(70);
    const working = result.data.rows.find(
      (r) => r.periodStart === "2026-06-30",
    )!;
    expect(working.values.SIMPLIFIED_WORKING_CAPITAL).toBe(30);
    expect(working.values.SIMPLIFIED_WORKING_CAPITAL_CHANGE).toBe(5);
  });
  it("uses period-end reported equity for TTM ROE and leaves missing equity empty", () => {
    const income = packet("financial.income", [
      ["2025-12-31", { PARENT_NETPROFIT: 20 }],
    ]);
    const balance = packet("financial.balance", [
      ["2025-12-31", { TOTAL_PARENT_EQUITY: 80, MINORITY_EQUITY: null }],
    ]);
    balance.envelope.data.rows[0]!.periodStart = "2025-12-31";
    const values = () =>
      deriveFinancialMetrics(scope, [income, balance])!.envelope.data.rows.find(
        (r) => r.periodStart === "2025-01-01",
      )!.values;
    expect(values().ROE_TTM_END_PARENT_EQUITY).toBe(0.25);
    balance.envelope.data.rows[0]!.values.TOTAL_PARENT_EQUITY = null;
    expect(values().ROE_TTM_END_PARENT_EQUITY).toBeNull();
    expect(values().TOTAL_PARENT_EQUITY).toBeNull();
    expect(values().MINORITY_EQUITY).toBeNull();
  });
  it.each(["source", "unit", "zero", "period"])(
    "leaves period-end ROE empty for incompatible %s",
    (problem) => {
      const income = packet("financial.income", [
        ["2025-12-31", { PARENT_NETPROFIT: 20 }],
      ]);
      const balance = packet("financial.balance", [
        ["2025-12-31", { TOTAL_PARENT_EQUITY: 80 }],
      ]);
      balance.envelope.data.rows[0]!.periodStart = "2025-12-31";
      if (problem === "source")
        balance.envelope.source.provider = "another-source";
      if (problem === "unit")
        balance.envelope.data.columns.TOTAL_PARENT_EQUITY!.unit = "USD";
      if (problem === "zero")
        balance.envelope.data.rows[0]!.values.TOTAL_PARENT_EQUITY = 0;
      if (problem === "period")
        balance.envelope.data.rows[0]!.date = "2025-09-30";
      const result = deriveFinancialMetrics(scope, [income, balance])!;
      expect(
        result.envelope.data.rows.find(
          (row) => row.periodStart === "2025-01-01",
        )!.values.ROE_TTM_END_PARENT_EQUITY,
      ).toBeNull();
    },
  );
  it("sums four contiguous SEC quarters and compares with prior four quarters", () => {
    const source = packet(
      "financial.revenue",
      [
        ["2024-03-31", { revenue: 10 }],
        ["2024-06-30", { revenue: 20 }],
        ["2024-09-30", { revenue: 30 }],
        ["2024-12-31", { revenue: 40 }],
        ["2025-03-31", { revenue: 20 }],
        ["2025-06-30", { revenue: 40 }],
        ["2025-09-30", { revenue: 60 }],
        ["2025-12-31", { revenue: 80 }],
      ],
      "USD",
    );
    for (const row of source.envelope.data.rows) {
      const month = Number(row.date.slice(5, 7)) - 2;
      row.periodStart = `${row.date.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
    }
    source.envelope.data.basis = "source_reported_period";
    const result = deriveFinancialMetrics(scope, [source])!.envelope;
    const values = result.data.rows.find(
      (r) => r.date === "2025-12-31",
    )!.values;
    expect(values.REVENUE_TTM).toBe(200);
    expect(values.REVENUE_TTM_YOY).toBe(100);
    expect(values.REVENUE_QUARTER).toBe(80);
    expect(result.data.columns.REVENUE_TTM!.label).toContain(
      "sum four contiguous non-overlapping quarters",
    );
    source.envelope.data.rows = source.envelope.data.rows.filter(
      (r) => r.date !== "2025-06-30",
    );
    expect(
      deriveFinancialMetrics(scope, [source])!.envelope.data.rows.find(
        (r) => r.date === "2025-12-31",
      )!.values.REVENUE_TTM,
    ).toBeNull();
  });
  it("propagates prior TTM-only dependencies, source limitations and valid field pointers", () => {
    const source = packet("financial.income", [
      ["2024-06-30", { PARENT_NETPROFIT: 10 }],
      ["2024-12-31", { PARENT_NETPROFIT: 100 }],
      ["2025-06-30", { PARENT_NETPROFIT: 20 }],
      ["2025-12-31", { PARENT_NETPROFIT: 200 }],
      ["2026-06-30", { PARENT_NETPROFIT: 40 }],
    ]);
    for (const row of source.envelope.data.rows)
      row.availableAt = "2026-07-01T00:00:00.000Z";
    const uniquePrior = source.envelope.data.rows[1]!;
    uniquePrior.availableAt = "2026-08-01T00:00:00.000Z";
    uniquePrior.asOf = "2026-07-15T00:00:00.000Z";
    uniquePrior.complete = false;
    source.envelope.gaps.push({
      code: "unverified_time",
      field: "/data/rows/0/publishedDate",
      detail: "Publication not established.",
    });
    const result = deriveFinancialMetrics(scope, [source])!.envelope;
    const current = result.data.rows.find((row) => row.date === "2026-06-30")!;
    expect(current.availableAt).toBe(uniquePrior.availableAt);
    expect(current.asOf).toBe(uniquePrior.asOf);
    expect(current.complete).toBe(false);
    expect(result.gaps).toContainEqual({
      code: "unverified_time",
      field: "/data",
      detail:
        "financial.income /data/rows/0/publishedDate: Publication not established.",
    });
    for (const gap of result.gaps) {
      const resolved = gap.field
        .split("/")
        .slice(1)
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          result,
        );
      expect(resolved).not.toBeUndefined();
    }
    expect(result.data.columns.NET_INCOME_YTD!.label).not.toContain("2026");
  });
  it("uses absolute prior-year bases for cumulative, quarterly and TTM growth", () => {
    const source = packet("financial.income", [
      ["2024-12-31", { PARENT_NETPROFIT: -100 }],
      ["2025-12-31", { PARENT_NETPROFIT: -50 }],
      ["2025-03-31", { PARENT_NETPROFIT: -100 }],
      ["2026-03-31", { PARENT_NETPROFIT: -50 }],
    ]);
    const result = deriveFinancialMetrics(scope, [source])!.envelope;
    const annual = result.data.rows.find(
      (row) => row.date === "2025-12-31",
    )!.values;
    expect(annual.NET_INCOME_YOY).toBe(50);
    expect(annual.NET_INCOME_TTM_YOY).toBe(50);
    const quarter = result.data.rows.find(
      (row) => row.date === "2026-03-31",
    )!.values;
    expect(quarter.NET_INCOME_QUARTER_YOY).toBe(50);
    expect(result.data.columns.NET_INCOME_YOY!.label).toContain(
      "abs(prior-year same period)",
    );
  });
  it("precomputes valuation-window statistics once, counting only non-null samples", () => {
    const financial = packet("financial.income", [
      ["2026-06-30", { PARENT_NETPROFIT: 20 }],
    ]);
    const valuation = packet(
      "valuation.history",
      [
        ["2026-09-01", { PE_TTM: 8, PB_MRQ: 1, PS_TTM: null, PCF_OCF_TTM: 30 }],
        [
          "2026-09-02",
          { PE_TTM: null, PB_MRQ: 2, PS_TTM: null, PCF_OCF_TTM: null },
        ],
        ["2026-09-03", { PE_TTM: 2, PB_MRQ: 3, PS_TTM: null, PCF_OCF_TTM: 10 }],
        ["2026-09-04", { PE_TTM: 6, PB_MRQ: 4, PS_TTM: null, PCF_OCF_TTM: 20 }],
        ["2026-09-05", { PE_TTM: 4, PB_MRQ: 5, PS_TTM: null, PCF_OCF_TTM: 40 }],
      ],
      "multiple",
    );
    valuation.envelope.data.rows[0]!.complete = false;
    const result = deriveFinancialMetrics(scope, [
      financial,
      valuation,
    ])!.envelope;
    const stats = result.data.rows.filter(
      (row) => row.values.HISTORY_PE_TTM_COUNT !== null,
    );
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      date: "2026-09-05",
      periodStart: "2026-09-05",
      complete: false,
      availableAt: null,
    });
    expect(stats[0]!.values).toMatchObject({
      HISTORY_PE_TTM_COUNT: 4,
      HISTORY_PE_TTM_MIN: 2,
      HISTORY_PE_TTM_MEDIAN: 5,
      HISTORY_PE_TTM_MAX: 8,
      HISTORY_PCF_OCF_TTM_MEDIAN: 25,
      HISTORY_PS_TTM_COUNT: 0,
      HISTORY_PS_TTM_MEDIAN: null,
    });
    expect(result.data.attributes).toMatchObject({
      valuationHistoryWindowStart: "2026-09-01",
      valuationHistoryWindowEnd: "2026-09-05",
    });
    expect(deriveFinancialMetrics(scope, [valuation])).toBeUndefined();
  });
});
