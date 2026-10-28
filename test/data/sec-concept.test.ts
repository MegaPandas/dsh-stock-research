import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecConceptQuery } from "../../src/contracts/fundamentals.js";
import { HttpClient, HttpStatusError } from "../../src/data/http.js";
import { SecConceptAdapter } from "../../src/data/sec-concept.js";
import { US_SECURITY } from "../fixtures/market.js";
import {
  SEC_REVENUE_TAG,
  secConcept,
  secFact,
} from "../fixtures/sec-concept.js";

const USER_AGENT = "CedarResearch/0.1";

function query(overrides: Partial<SecConceptQuery> = {}): SecConceptQuery {
  return {
    scope: {
      security: US_SECURITY,
      date: "2024-06-30",
      cutoff: "2024-07-01T02:00:00.000Z",
    },
    cik: "0000000001",
    field: "revenue",
    periodEndFrom: "2024-01-01",
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

function setup(response: unknown = secConcept()) {
  const http = new HttpClient({
    timeoutMs: 1_000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi
    .spyOn(http, "getText")
    .mockResolvedValue(JSON.stringify(response));
  return { adapter: new SecConceptAdapter(http, USER_AGENT), get };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SEC company concept", () => {
  it("requires a nonempty declared identity before making requests", () => {
    const http = new HttpClient({
      timeoutMs: 1000,
      maxConcurrency: 1,
      minIntervalMs: 0,
    });
    expect(() => new SecConceptAdapter(http, "  ")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([
    ["revenue", SEC_REVENUE_TAG],
    ["netIncome", "NetIncomeLoss"],
  ] as const)("requests only the selected %s concept", async (field, tag) => {
    const { adapter, get } = setup(secConcept([secFact()], { tag }));
    const signal = new AbortController().signal;
    const result = await adapter.query(query({ field }), signal);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, options] = get.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/us-gaap/${tag}.json`,
    );
    expect(new Headers(options?.headers).get("User-Agent")).toBe(USER_AGENT);
    expect(options?.signal).toBe(signal);
    expect(result.data).toMatchObject({
      field,
      currency: "USD",
      concept: { taxonomy: "us-gaap", tag },
    });
    expect(result.data.observations[0]!.value).toBe(123_456_789);
  });

  it("retains revisions and comparative periods without using fiscal labels", async () => {
    const { adapter } = setup(
      secConcept([
        secFact({
          val: 130,
          filed: "2024-06-01",
          accn: "0000000001-24-000003",
          form: "10-Q/A",
        }),
        secFact({ start: "2023-01-01", end: "2023-03-31", val: 90 }),
        secFact({ val: 120 }),
      ]),
    );
    const result = await adapter.query(query({ periodEndFrom: "2023-01-01" }));
    expect(
      result.data.observations.map(
        ({ periodStart, periodEnd, value, filed }) => ({
          periodStart,
          periodEnd,
          value,
          filed,
        }),
      ),
    ).toEqual([
      {
        periodStart: "2023-01-01",
        periodEnd: "2023-03-31",
        value: 90,
        filed: "2024-05-01",
      },
      {
        periodStart: "2024-01-01",
        periodEnd: "2024-03-31",
        value: 120,
        filed: "2024-05-01",
      },
      {
        periodStart: "2024-01-01",
        periodEnd: "2024-03-31",
        value: 130,
        filed: "2024-06-01",
      },
    ]);
    expect(result.data.observations[2]).toMatchObject({
      form: "10-Q/A",
      accession: "0000000001-24-000003",
    });
  });

  it("filters filing dates in New York and separates period, filing and retrieval dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T08:00:00.000Z"));
    const { adapter } = setup(
      secConcept([
        secFact({ filed: "2024-06-30" }),
        secFact({ filed: "2024-07-01", accn: "0000000001-24-000002" }),
        secFact({ start: "2023-01-01", end: "2023-12-31" }),
        secFact({ end: "2024-07-01", filed: "2024-07-02" }),
      ]),
    );
    const result = await adapter.query(query()); // UTC July 1 is still June 30 in New York.
    expect(result.data.observations).toHaveLength(1);
    expect(result.data.observations[0]).toMatchObject({
      filed: "2024-06-30",
      availableAt: null,
    });
    expect(result.data.observations[0]!.filingUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/000000000124000001/0000000001-24-000001-index.html",
    );
    expect(result).toMatchObject({
      asOf: "2024-03-31T23:59:59.999Z",
      retrievedAt: "2026-10-25T08:00:00.000Z",
      cutoff: "2024-07-01T02:00:00.000Z",
      availableAt: null,
      historicalKnowledge: "unverified",
      stale: true,
    });
    expect(result.ageMs).toBe(
      Date.parse("2024-07-01T02:00:00.000Z") -
        Date.parse("2024-03-31T23:59:59.999Z"),
    );
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unverified_time" }),
        expect.objectContaining({ code: "stale" }),
      ]),
    );
  });

  it("preserves losses and marks missing values", async () => {
    const { adapter } = setup(
      secConcept(
        [
          secFact({ val: -42 }),
          secFact({ val: null, accn: "0000000001-24-000002" }),
        ],
        { tag: "NetIncomeLoss" },
      ),
    );
    const result = await adapter.query(query({ field: "netIncome" }));
    expect(result.data.observations.map(({ value }) => value)).toEqual([
      -42,
      null,
    ]);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/observations/1/value",
      }),
    );
  });

  it("rejects a non-finite JSON amount instead of treating it as missing", async () => {
    const { adapter, get } = setup();
    get.mockResolvedValue(
      JSON.stringify(secConcept()).replace("123456789", "1e400"),
    );
    await expect(adapter.query(query())).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it.each([
    secConcept([], { cik: 2 }),
    secConcept([], { taxonomy: "ifrs-full" }),
    secConcept([], { tag: "NetIncomeLoss" }),
    secConcept([], { units: [] }),
    secConcept([], { units: { USD: {} } }),
    secConcept([secFact({ val: "42" })]),
    secConcept([secFact({ end: "2024-02-30" })]),
    secConcept([secFact({ filed: "2024-02-01" })]),
    secConcept([secFact({ accn: "invalid" })]),
  ])(
    "rejects malformed source boundaries without a second request",
    async (response) => {
      const { adapter, get } = setup(response);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    secConcept([], { units: { EUR: [secFact()] } }),
    secConcept([]),
    secConcept([secFact({ filed: "2024-07-01" })]),
  ])(
    "reports insufficient data without switching concepts or currencies",
    async (response) => {
      const { adapter, get } = setup(response);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "DATA_INSUFFICIENT",
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error("offline"),
    new HttpStatusError(
      new Response(null, { status: 429, statusText: "Too Many Requests" }),
    ),
  ])("propagates transport errors without retrying", async (error) => {
    const { adapter, get } = setup();
    get.mockRejectedValue(error);
    await expect(adapter.query(query())).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
