import { describe, expect, it, vi } from "vitest";
import { createUsCollectionTasks } from "../../src/services/collection-us.js";
import type { QueryService } from "../../src/services/query.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { CollectionService } from "../../src/services/collection.js";
import { HttpClient } from "../../src/data/http.js";
import type { SqliteCache } from "../../src/cache/index.js";
import { US_SECURITY } from "../fixtures/market.js";

const scope = {
  security: US_SECURITY,
  date: "2026-10-26",
  cutoff: "2026-10-26T22:00:00.000Z",
};
const options = {
  enabledSources: ["sec"],
  freshness: { market: 0, fundamentals: 0, macro: 0 },
  secCiks: { [US_SECURITY.id]: "0001045810" },
  ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
};

describe("configured US collection", () => {
  it("clips the fixed daily lookback at the configured source's historical coverage", async () => {
    const earlyScope = {
      ...scope,
      date: "2024-01-03",
      cutoff: "2024-01-03T22:00:00.000Z",
    };
    const query = vi
      .fn()
      .mockRejectedValue(new Error("fixture stop after observing the request"));
    const tasks = createUsCollectionTasks(
      { query: query as QueryService["query"] },
      earlyScope,
      { ...options, enabledSources: ["yahoo"] },
    );
    await expect(tasks[0]!.run()).rejects.toThrow("fixture stop");
    expect(query).toHaveBeenCalledWith(
      earlyScope,
      expect.objectContaining({
        parameters: expect.objectContaining({ startDate: "2024-01-01" }),
      }),
      undefined,
    );
  });
  it("retains different reporting periods with a common end date and the selected filing lineage", async () => {
    const query = vi.fn().mockResolvedValue({
      dataset: "fundamentals",
      data: {
        field: "revenue",
        currency: "USD",
        concept: { taxonomy: "us-gaap", tag: "Revenues" },
        observations: [
          {
            periodStart: "2026-01-01",
            periodEnd: "2026-06-30",
            value: 10,
            filed: "2026-08-01",
            accession: "old",
            form: "10-Q",
            filingUrl: "https://example.com/old",
            availableAt: null,
          },
          {
            periodStart: "2026-04-01",
            periodEnd: "2026-06-30",
            value: 6,
            filed: "2026-08-01",
            accession: "quarter",
            form: "10-Q",
            filingUrl: "https://example.com/quarter",
            availableAt: null,
          },
          {
            periodStart: "2026-01-01",
            periodEnd: "2026-06-30",
            value: 11,
            filed: "2026-08-02",
            accession: "revised",
            form: "10-Q/A",
            filingUrl: "https://example.com/revised",
            availableAt: null,
          },
        ],
      },
      source: {
        provider: "sec",
        url: "https://example.com/concept",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: "2026-06-30T23:59:59.999Z",
      availableAt: null,
      retrievedAt: scope.cutoff,
      cutoff: scope.cutoff,
      ageMs: 1,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [
        {
          code: "stale",
          field: "/data/observations",
          detail: "Original freshness warning.",
        },
      ],
    });
    const tasks = createUsCollectionTasks(
      { query: query as QueryService["query"] },
      scope,
      options,
    );
    const result = await tasks[0]!.run();
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows).toContainEqual(
      expect.objectContaining({
        periodStart: "2026-01-01",
        values: { revenue: 11 },
        publishedDate: "2026-08-02",
        filing: {
          accession: "revised",
          form: "10-Q/A",
          url: "https://example.com/revised",
        },
      }),
    );
    expect(result.data.rows).toContainEqual(
      expect.objectContaining({
        periodStart: "2026-04-01",
        values: { revenue: 6 },
      }),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "stale",
        detail: "Original freshness warning.",
      }),
    );
  });

  it("propagates cache or internal contract failures instead of recording a source gap", async () => {
    const error = new ResearchError("STORAGE_FAILED", "Cache is unavailable.");
    const query = vi.fn().mockRejectedValue(error) as QueryService["query"];
    const http = new HttpClient({
      timeoutMs: 1000,
      maxConcurrency: 1,
      minIntervalMs: 0,
    });
    const cache = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as SqliteCache;
    const service = new CollectionService(http, cache, { query }, options);
    try {
      await expect(service.collect(scope)).rejects.toBe(error);
    } finally {
      await service.close();
      await http.close();
    }
  });
});
