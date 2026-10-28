import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FredQuery } from "../../src/contracts/macro.js";
import { FredCsvAdapter } from "../../src/data/fred-csv.js";
import { HttpClient, HttpStatusError } from "../../src/data/http.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const sample = readFileSync(
  new URL("../fixtures/sources/fred-dgs10.csv", import.meta.url),
  "utf8",
);

function query(overrides: Partial<FredQuery> = {}): FredQuery {
  return {
    scope: {
      security: US_SECURITY,
      date: "2024-01-05",
      cutoff: "2024-01-05T12:00:00.000Z",
    },
    seriesId: "DGS10",
    startDate: "2024-01-01",
    endDate: "2024-01-05",
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

function setup(text = sample) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(text);
  return { adapter: new FredCsvAdapter(http), get };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FRED current CSV", () => {
  it("preserves sampled percent levels and separates observation labels from retrieval and availability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T08:00:00.000Z"));
    const { adapter } = setup();
    const result = await adapter.query(query());
    expect(result.data).toEqual({
      seriesId: "DGS10",
      unit: "percent",
      frequency: "daily",
      seasonalAdjustment: "not_seasonally_adjusted",
      view: "current",
      observations: [
        { date: "2024-01-02", value: 3.95, availableAt: null },
        { date: "2024-01-03", value: 3.91, availableAt: null },
        { date: "2024-01-04", value: 3.99, availableAt: null },
        { date: "2024-01-05", value: 4.05, availableAt: null },
      ],
    });
    expect(result).toMatchObject({
      dataset: "macro",
      asOf: "2024-01-05T00:00:00.000Z",
      retrievedAt: "2026-10-25T08:00:00.000Z",
      cutoff: "2024-01-05T12:00:00.000Z",
      ageMs: 43_200_000,
      stale: false,
      availableAt: null,
      historicalKnowledge: "unverified",
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "unverified_time",
        field: "/data/observations",
      }),
    );
  });

  it("makes one bounded single-series request with cancellation and no transformations", async () => {
    const { adapter, get } = setup();
    const signal = new AbortController().signal;
    const result = await adapter.query(query(), signal);
    expect(get).toHaveBeenCalledTimes(1);
    const [input, options] = get.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(
      "https://fred.stlouisfed.org/graph/fredgraph.csv",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id: "DGS10",
      cosd: "2024-01-01",
      coed: "2024-01-05",
    });
    expect(options?.signal).toBe(signal);
    expect(result.source).toMatchObject({ provider: "fred", url: url.href });
  });

  it.each([
    ["FEDFUNDS", "percent", "not_seasonally_adjusted", "5.33", 5.33],
    [
      "CPIAUCSL",
      "index_1982_1984_100",
      "seasonally_adjusted",
      "308.417",
      308.417,
    ],
  ] as const)(
    "retains %s monthly units and the first-day period label",
    async (seriesId, unit, seasonalAdjustment, raw, value) => {
      const { adapter } = setup(
        `observation_date,${seriesId}\n2024-01-01,${raw}\n`,
      );
      const result = await adapter.query(query({ seriesId }));
      expect(result.data).toEqual({
        seriesId,
        unit,
        frequency: "monthly",
        seasonalAdjustment,
        view: "current",
        observations: [{ date: "2024-01-01", value, availableAt: null }],
      });
      expect(result.asOf).toBe("2024-01-01T00:00:00.000Z");
    },
  );

  it("does not change a US macro series to the research security's currency", async () => {
    const { adapter } = setup();
    const result = await adapter.query(
      query({ scope: { ...query().scope, security: CN_SECURITY } }),
    );
    expect(result.data.unit).toBe("percent");
    expect(result.data.observations[0]!.value).toBe(3.95);
  });

  it("accepts CRLF and terminal blank lines, sorts dates, and retains empty values, zero and negatives", async () => {
    const { adapter } = setup(
      "observation_date,DGS10\r\n2024-01-04,-0.25\r\n2024-01-02,\r\n2024-01-03,0\r\n\r\n",
    );
    const result = await adapter.query(query());
    expect(result.data.observations).toEqual([
      { date: "2024-01-02", value: null, availableAt: null },
      { date: "2024-01-03", value: 0, availableAt: null },
      { date: "2024-01-04", value: -0.25, availableAt: null },
    ]);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/observations/0/value",
      }),
    );
    expect(result.gaps.filter(({ code }) => code === "missing")).toHaveLength(
      1,
    );
  });

  it("filters the requested range and UTC date anchor, including exact cutoff equality", async () => {
    const { adapter } = setup(
      "observation_date,DGS10\n2023-12-31,1\n2024-01-02,2\n2024-01-03,3\n2024-01-04,4\n2024-01-05,5\n2024-01-06,6\n",
    );
    const result = await adapter.query(
      query({
        startDate: "2024-01-02",
        endDate: "2024-01-05",
        scope: {
          security: CN_SECURITY,
          date: "2024-01-05",
          cutoff: "2024-01-04T16:00:00.000Z",
        },
      }),
    );
    expect(
      result.data.observations.map(({ date, value }) => [date, value]),
    ).toEqual([
      ["2024-01-02", 2],
      ["2024-01-03", 3],
      ["2024-01-04", 4],
    ]);
    expect(result.asOf).toBe("2024-01-04T00:00:00.000Z");
    expect(result.ageMs).toBe(57_600_000);
    const exact = await adapter.query(
      query({
        startDate: "2024-01-02",
        endDate: "2024-01-04",
        scope: {
          security: CN_SECURITY,
          date: "2024-01-04",
          cutoff: "2024-01-04T00:00:00.000Z",
        },
      }),
    );
    expect(exact.data.observations.at(-1)!.date).toBe("2024-01-04");
    expect(exact.ageMs).toBe(0);
  });

  it("marks stale only strictly beyond the policy age", async () => {
    const { adapter } = setup();
    const equal = await adapter.query(query({ maxAgeMs: 43_200_000 }));
    const older = await adapter.query(query({ maxAgeMs: 43_199_999 }));
    expect(equal.stale).toBe(false);
    expect(equal.gaps.some(({ code }) => code === "stale")).toBe(false);
    expect(older.stale).toBe(true);
    expect(older.gaps).toContainEqual(
      expect.objectContaining({ code: "stale", field: "/data/observations" }),
    );
  });

  it.each([
    "observation_date,FEDFUNDS\n2024-01-02,3.95\n",
    "DATE,DGS10\n2024-01-02,3.95\n",
    "observation_date,DGS10\n2024-01-02,3.95,extra\n",
    "observation_date,DGS10\n2024-02-30,3.95\n",
    "observation_date,DGS10\n2024-01-02,.\n",
    `observation_date,DGS10\n2024-01-02,${"9".repeat(400)}\n`,
    "observation_date,DGS10\n2024-01-02,3.95\n2024-01-02,3.91\n",
  ])(
    "rejects incorrect source schemas and malformed observations without retrying",
    async (text) => {
      const { adapter, get } = setup(text);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "observation_date,DGS10\n",
    "observation_date,DGS10\n2023-12-29,3.88\n",
  ])("reports no retained observations as insufficient", async (text) => {
    const { adapter, get } = setup(text);
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
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
});
