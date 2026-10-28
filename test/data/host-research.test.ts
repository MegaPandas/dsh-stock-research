import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostWebSearch,
  ResearchQuery,
} from "../../src/contracts/research.js";
import { HostResearchAdapter } from "../../src/data/host-research.js";
import { US_SECURITY } from "../fixtures/market.js";

function query(): ResearchQuery {
  return {
    scope: {
      security: US_SECURITY,
      date: "2024-06-30",
      cutoff: "2024-06-30T20:00:00.000Z",
    },
    query: "NVDA supply & demand",
    maxResults: 2,
  };
}

// Synthetic protocol examples; these are not captured host/backend search results.
function source(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/report?q=chips#outlook",
    title: "  Semiconductor outlook  ",
    snippet: "Demand increased.",
    publishedAt: "2024-06-01T12:00:00Z",
    ...overrides,
  };
}

function setup(raw: unknown = { sources: [source()], truncated: false }) {
  const search = vi.fn<HostWebSearch>().mockResolvedValue(raw);
  return { adapter: new HostResearchAdapter(search), search };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("host research protocol adapter", () => {
  it("forwards exactly one bounded host request and its cancellation signal", async () => {
    const { adapter, search } = setup();
    const signal = new AbortController().signal;
    const result = await adapter.query(query(), signal);
    expect(search).toHaveBeenCalledExactlyOnceWith(
      { query: "NVDA supply & demand", maxResults: 2 },
      signal,
    );
    const operation = new URL(result.source.url);
    expect(operation.protocol).toBe("dsh:");
    expect(operation.hostname).toBe("web");
    expect(operation.pathname).toBe("/search");
    expect(Object.fromEntries(operation.searchParams)).toEqual({
      query: "NVDA supply & demand",
      maxResults: "2",
    });
    expect(result.source.provider).toBe("dsh-web");
  });

  it("preserves source text and URLs while keeping supplier timestamps separate from verified publication", async () => {
    const { adapter } = setup();
    const result = await adapter.query(query());
    expect(result.data).toEqual({
      query: query().query,
      view: "current_search",
      truncated: false,
      items: [
        {
          url: "https://example.com/report?q=chips#outlook",
          title: "  Semiconductor outlook  ",
          snippet: "Demand increased.",
          providerTimestamp: "2024-06-01T12:00:00Z",
          publishedAt: null,
          availableAt: null,
          location: null,
        },
      ],
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/items/0/location",
      }),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: "unverified_time",
        field: "/data/items",
      }),
    );
  });

  it("records the present search snapshot without pretending it existed at historical cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T08:00:00.000Z"));
    const { adapter } = setup();
    const result = await adapter.query(query());
    expect(result).toMatchObject({
      dataset: "research",
      asOf: "2026-10-25T08:00:00.000Z",
      retrievedAt: "2026-10-25T08:00:00.000Z",
      cutoff: "2024-06-30T20:00:00.000Z",
      availableAt: null,
      historicalKnowledge: "unverified",
      stale: false,
    });
    expect(result.ageMs).toBe(
      Date.parse("2024-06-30T20:00:00.000Z") -
        Date.parse("2026-10-25T08:00:00.000Z"),
    );
    expect(result.ageMs).toBeLessThan(0);
  });

  it("normalizes missing and blank optional text with field-specific gaps, without using generated answers", async () => {
    const { adapter } = setup({
      content: "Generated answer must not become an article excerpt.",
      sources: [
        source({ title: undefined, snippet: " \n", publishedAt: undefined }),
        source({ title: "\t", snippet: undefined, publishedAt: " " }),
      ],
      truncated: false,
    });
    const result = await adapter.query(query());
    expect(
      result.data.items.map(({ title, snippet, providerTimestamp }) => [
        title,
        snippet,
        providerTimestamp,
      ]),
    ).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    expect(result.data).not.toHaveProperty("content");
    for (const field of [
      "/data/items/0/title",
      "/data/items/0/snippet",
      "/data/items/1/title",
      "/data/items/1/snippet",
    ]) {
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ code: "missing", field }),
      );
    }
  });

  it("retains opaque provider date text without interpreting it as publication or dropping the source", async () => {
    const { adapter } = setup({
      sources: [source({ publishedAt: "crawled recently" })],
      truncated: false,
    });
    const result = await adapter.query(query());
    expect(result.data.items[0]).toMatchObject({
      providerTimestamp: "crawled recently",
      publishedAt: null,
      availableAt: null,
    });
  });

  it("preserves host truncation and result order", async () => {
    const sources = [
      source({ url: "http://example.com/first" }),
      source({ url: "https://example.com/second" }),
    ];
    const { adapter, search } = setup({ sources, truncated: true });
    const result = await adapter.query(query());
    expect(result.data.items.map(({ url }) => url)).toEqual(
      sources.map(({ url }) => url),
    );
    expect(result.data.truncated).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit successful empty result without inventing sources from content", async () => {
    const { adapter, search } = setup({
      content: "A generated answer with no source.",
      sources: [],
      truncated: false,
    });
    const result = await adapter.query(query());
    expect(result.data).toEqual({
      query: query().query,
      items: [],
      truncated: false,
      view: "current_search",
    });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sources: {}, truncated: false },
    { sources: [], truncated: "false" },
    { sources: [source({ url: "/relative" })], truncated: false },
    { sources: [source({ url: "file:///tmp/report" })], truncated: false },
    { sources: [source({ title: 42 })], truncated: false },
    { sources: [source({ snippet: null })], truncated: false },
    { sources: [source({ publishedAt: 1_700_000_000 })], truncated: false },
  ])(
    "rejects malformed source boundaries without retrying or returning empty success",
    async (raw) => {
      const { adapter, search } = setup(raw);
      await expect(adapter.query(query())).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect(search).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error("backend unavailable"),
    new DOMException("cancelled", "AbortError"),
  ])("propagates host failures and cancellation unchanged", async (error) => {
    const { adapter, search } = setup();
    search.mockRejectedValue(error);
    await expect(adapter.query(query())).rejects.toBe(error);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
