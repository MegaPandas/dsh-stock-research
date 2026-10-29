import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionOptions } from "../../src/contracts/collection.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import { HttpClient } from "../../src/data/http.js";
import { createCollectionPlans } from "../../src/services/collection-plan.js";
import type { QueryService } from "../../src/services/query.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const clients: HttpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

function plans(
  enabledSources: string[],
  settings: Partial<CollectionOptions> = {},
  security = CN_SECURITY,
) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  clients.push(http);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Planning must not request source data");
  });
  const query = vi.fn() as QueryService["query"];
  const scope: ResearchScope = {
    security,
    date: "2026-10-28",
    cutoff: "2026-10-28T10:00:00.000Z",
  };
  const result = createCollectionPlans(http, { query }, scope, {
    enabledSources,
    freshness: { market: 86400000, fundamentals: 0, macro: 0 },
    secCiks: {},
    ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
    ...settings,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  return result;
}

describe("configured collection plans", () => {
  it("groups sources into unique logical tables in source preference order", () => {
    const { plans: result } = plans(
      ["eastmoney-market", "tencent", "sina", "xueqiu"],
      { xueqiuCookie: "fixture" },
    );
    expect(new Set(result.map(({ id }) => id)).size).toBe(result.length);
    for (const id of ["market.daily", "market.weekly", "market.monthly"]) {
      const selected = result.find((plan) => plan.id === id)!;
      expect(selected.candidates.map(({ provider }) => provider)).toEqual([
        "eastmoney",
        "tencent",
        "sina",
        "xueqiu",
      ]);
      expect(
        selected.candidates.every((candidate) => candidate.id === id),
      ).toBe(true);
    }
  });

  it("keeps enabled market alternatives when the primary is disabled", () => {
    const { plans: result, disabled } = plans(["tencent", "sina"]);
    expect(
      result
        .find(({ id }) => id === "market.daily")!
        .candidates.map(({ provider }) => provider),
    ).toEqual(["tencent", "sina"]);
    expect(disabled).toContainEqual(
      expect.objectContaining({
        id: "valuation.history",
        code: "SOURCE_UNAVAILABLE",
      }),
    );
  });

  it("requires the benchmark switch and respects alternative provider switches", () => {
    expect(
      plans(["tencent", "sina", "yahoo"]).plans.some(({ id }) =>
        id.startsWith("benchmark."),
      ),
    ).toBe(false);
    const primary = plans(["benchmarks"]).plans;
    expect(
      primary
        .find(({ id }) => id === "benchmark.usdcny.daily")!
        .candidates.map(({ provider }) => provider),
    ).toEqual(["yahoo"]);
    expect(
      primary
        .find(({ id }) => id === "benchmark.shanghai.daily")!
        .candidates.map(({ provider }) => provider),
    ).toEqual(["eastmoney"]);
    const withStandby = plans(["benchmarks", "tencent"]).plans;
    expect(
      withStandby
        .find(({ id }) => id === "benchmark.shanghai.daily")!
        .candidates.map(({ provider }) => provider),
    ).toEqual(["eastmoney", "tencent"]);
  });

  it("creates SEC financial tasks only with both enablement and a configured CIK", () => {
    const secCiks = { [US_SECURITY.id]: "0001045810" };
    expect(
      plans(["yahoo"], { secCiks }, US_SECURITY).plans.some(
        ({ dataset }) => dataset === "fundamentals",
      ),
    ).toBe(false);
    expect(
      plans(["yahoo", "sec"], {}, US_SECURITY).plans.some(
        ({ dataset }) => dataset === "fundamentals",
      ),
    ).toBe(false);
    const configured = plans(["yahoo", "sec"], { secCiks }, US_SECURITY).plans;
    expect(
      configured
        .filter(({ dataset }) => dataset === "fundamentals")
        .map(({ id }) => id),
    ).toEqual(["financial.revenue", "financial.netIncome"]);
  });

  it("assigns the required daily budget separately from ordinary tables", () => {
    const required = plans(["tencent"], { requireDailyMarket: true }).plans;
    expect(required.find(({ id }) => id === "market.daily")).toMatchObject({
      required: true,
      timeoutMs: 45000,
    });
    expect(required.find(({ id }) => id === "market.weekly")).toMatchObject({
      required: false,
      timeoutMs: 120000,
    });
    expect(
      plans(["tencent"]).plans.find(({ id }) => id === "market.daily"),
    ).toMatchObject({ required: false, timeoutMs: 120000 });
  });
});
