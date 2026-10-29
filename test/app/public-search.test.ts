import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { createPublicSearchSession } from "../../src/app/public-search.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import type {
  ResearchData,
  ResearchItem,
} from "../../src/contracts/research.js";
import { ResearchError } from "../../src/contracts/errors.js";

function context(signal = new AbortController().signal): ToolRunContext {
  return {
    name: "stock_search_public",
    arguments: { query: "revenue" },
    callId: "public-search" as ToolRunContext["callId"],
    rootCallId: "public-search" as ToolRunContext["rootCallId"],
    token: Symbol("execution") as ToolRunContext["token"],
    signal,
    deferContext() {},
    concludeTurn() {},
  };
}

const source: ResearchItem = {
  title: "Revenue 123.45亿元",
  url: "https://example.com/report",
  snippet: "收入123.45亿元，同比+12.30%",
  providerTimestamp: "2026-10-27",
  publishedAt: null,
  availableAt: null,
  location: null,
};

function result(items = [source], truncated = false) {
  const envelope: DataEnvelope<ResearchData> = {
    dataset: "research",
    data: { query: "revenue", items, truncated, view: "current_search" },
    source: {
      provider: "dsh-web",
      url: source.url,
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: "2026-10-27T00:00:00Z",
    availableAt: null,
    retrievedAt: "2026-10-27T01:00:00Z",
    cutoff: "2026-10-27T00:00:00Z",
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
    candidateClaims: [],
  };
  return envelope;
}

function fixture(
  run: (
    query: string,
    exec: ToolRunContext,
  ) => Promise<DataEnvelope<ResearchData>> = async () => result(),
  approval: (
    query: string,
    exec: ToolRunContext,
    used: number,
  ) => Promise<boolean> = async () => false,
  maxSearches?: number,
) {
  const execute = vi.fn(run);
  const approve = vi.fn(approval);
  const session = createPublicSearchSession(
    { search: execute, approve },
    maxSearches,
  );
  return { execute, approve, session, tool: session.tool };
}

describe("public search budget tool", () => {
  it.each([0, 2])(
    "requires approval for every search beyond the configured allowance %s",
    async (limit) => {
      const { tool, execute, approve } = fixture(
        undefined,
        async () => true,
        limit,
      );
      expect(tool.description).toContain(
        `The first ${limit} searches need no approval`,
      );
      for (let used = 1; used <= limit + 3; used += 1) {
        const exec = context();
        await expect(
          tool.execute({ query: "revenue" }, exec),
        ).resolves.toMatchObject({
          budget: { limit, used, remaining: Math.max(limit - used, 0) },
        });
        if (used > limit)
          expect(approve).toHaveBeenLastCalledWith("revenue", exec, used - 1);
        expect(approve).toHaveBeenCalledTimes(Math.max(used - limit, 0));
      }
      expect(execute).toHaveBeenCalledTimes(limit + 3);
    },
  );

  it("requires separate approval for every search after the eighth", async () => {
    const { tool, execute, approve } = fixture(undefined, async () => true);
    for (let used = 1; used <= 10; used += 1) {
      const exec = context();
      await expect(
        tool.execute({ query: "revenue" }, exec),
      ).resolves.toMatchObject({
        budget: { limit: 8, used, remaining: Math.max(8 - used, 0) },
      });
      if (used > 8)
        expect(approve).toHaveBeenLastCalledWith("revenue", exec, used - 1);
      expect(approve).toHaveBeenCalledTimes(Math.max(used - 8, 0));
    }
    expect(execute).toHaveBeenCalledTimes(10);
  });

  it.each(["unavailable", "cancelled"])(
    "does not search or consume budget when approval is %s",
    async (kind) => {
      const reason = new ResearchError("ACCESS_DENIED", kind);
      const { tool, execute, approve } = fixture(undefined, async () => {
        throw reason;
      });
      for (let index = 0; index < 8; index += 1)
        await tool.execute({ query: "revenue" }, context());
      for (let index = 0; index < 3; index += 1)
        await expect(
          tool.execute({ query: "revenue" }, context()),
        ).rejects.toMatchObject({
          code: "ACCESS_DENIED",
          cause: reason,
        });
      expect(execute).toHaveBeenCalledTimes(8);
      expect(approve).toHaveBeenCalledTimes(3);
      expect(approve).toHaveBeenLastCalledWith("revenue", expect.anything(), 8);
      approve.mockResolvedValueOnce(true);
      await expect(
        tool.execute({ query: "revenue" }, context()),
      ).resolves.toMatchObject({ budget: { used: 9 } });
    },
  );

  it("pauses search after two explicit refusals and rejects repeated or rephrased requests without prompting", async () => {
    const { tool, execute, approve } = fixture(undefined, undefined, 1);
    await tool.execute({ query: "product deliveries" }, context());
    await expect(
      tool.execute({ query: "additional product deliveries" }, context()),
    ).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: expect.stringContaining("Search approval denied (1/2)"),
    });
    for (const query of [
      "latest product deliveries",
      "latest product deliveries",
      "competitor launches",
    ])
      await expect(tool.execute({ query }, context())).rejects.toMatchObject({
        code: "ACCESS_DENIED",
        message: expect.stringContaining("Search is paused"),
      });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls.map(([, , used]) => used)).toEqual([1, 1]);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "product deliveries",
      expect.anything(),
    );
  });

  it("retains earlier refusals after a later search is approved", async () => {
    const { tool, execute, approve } = fixture(undefined, undefined, 0);
    approve
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      tool.execute({ query: "refused query" }, context()),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      tool.execute({ query: "approved query" }, context()),
    ).resolves.toMatchObject({ budget: { used: 1 } });
    await expect(
      tool.execute({ query: "another refused query" }, context()),
    ).rejects.toThrow("Search is paused");
    await expect(
      tool.execute({ query: "another attempt" }, context()),
    ).rejects.toThrow("Search is paused");
    expect(approve).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "approved query",
      expect.anything(),
    );
  });

  it("resumes only by host request, retains spent allowance and pauses again after two refusals", async () => {
    const { session, tool, execute, approve } = fixture(
      undefined,
      undefined,
      1,
    );
    await tool.execute({ query: "initial material" }, context());
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        tool.execute({ query: "more material" }, context()),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    approve.mockResolvedValue(true);
    for (let turn = 0; turn < 3; turn += 1) {
      expect(session.tool).toBe(tool);
      expect(tool.description).toContain(
        "resumption requires a decision by the primary agent or user",
      );
      await expect(
        tool.execute({ query: `follow-up ${turn}` }, context()),
      ).rejects.toThrow("Search is paused");
    }
    expect(approve).toHaveBeenCalledTimes(2);
    session.resume();
    await expect(
      tool.execute({ query: "host resumed query" }, context()),
    ).resolves.toMatchObject({ budget: { limit: 1, used: 2, remaining: 0 } });
    expect(approve).toHaveBeenLastCalledWith(
      "host resumed query",
      expect.anything(),
      1,
    );
    approve.mockResolvedValue(false);
    await expect(
      tool.execute({ query: "new refusal" }, context()),
    ).rejects.toThrow("Search approval denied (1/2)");
    await expect(
      tool.execute({ query: "second new refusal" }, context()),
    ).rejects.toThrow("Search is paused");
    await expect(
      tool.execute({ query: "still paused" }, context()),
    ).rejects.toThrow("Search is paused");
    expect(approve).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent approvals and stops queued requests after two refusals", async () => {
    let decide!: (allowed: boolean) => void;
    const { tool, execute, approve } = fixture(
      undefined,
      () => new Promise<boolean>((resolve) => (decide = resolve)),
      0,
    );
    const settled = Promise.allSettled(
      ["query one", "query two", "query three", "query four"].map((query) =>
        tool.execute({ query }, context()),
      ),
    );
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    decide(false);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    decide(false);
    const outcomes = await settled;
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { code: "ACCESS_DENIED" },
    });
    for (const outcome of outcomes.slice(1))
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringContaining("Search is paused") },
      });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after approval before reserving a search", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled while approving");
    const { tool, execute } = fixture(undefined, async () => {
      controller.abort(reason);
      return true;
    });
    for (let index = 0; index < 8; index += 1)
      await tool.execute({ query: "revenue" }, context());
    await expect(
      tool.execute({ query: "revenue" }, context(controller.signal)),
    ).rejects.toBe(reason);
    expect(execute).toHaveBeenCalledTimes(8);
    await expect(
      tool.execute({ query: "revenue" }, context()),
    ).resolves.toMatchObject({
      budget: { used: 9, remaining: 0 },
    });
  });

  it("does not mark native result counts above five as truncated", async () => {
    const { tool } = fixture(async () =>
      result(Array.from({ length: 7 }, () => source)),
    );
    await expect(
      tool.execute({ query: "revenue" }, context()),
    ).resolves.toMatchObject({
      sources: Array.from({ length: 7 }, () => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        timeHint: source.providerTimestamp,
      })),
      truncated: false,
    });
  });

  it("projects business data and forwards query and execution", async () => {
    const { tool, execute } = fixture();
    const exec = context();
    expect(tool.name).toBe("stock_search_public");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(await tool.execute({ query: "revenue" }, exec)).toEqual({
      query: "revenue",
      retrievedAt: "2026-10-27T01:00:00Z",
      timestampScope: "current_search",
      sources: [
        {
          title: source.title,
          url: source.url,
          snippet: source.snippet,
          timeHint: source.providerTimestamp,
        },
      ],
      truncated: false,
      budget: { limit: 8, used: 1, remaining: 7 },
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("revenue", exec);
  });

  it("reserves the budget before concurrent searches finish", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tool, execute } = fixture(async () => {
      await pending;
      return result();
    });
    const calls = Array.from({ length: 9 }, () =>
      tool.execute({ query: "revenue" }, context()),
    );
    const settled = Promise.allSettled(calls);
    expect(execute).toHaveBeenCalledTimes(8);
    release();
    const outcomes = await settled;
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(8);
    expect(outcomes[8]).toMatchObject({
      status: "rejected",
      reason: { code: "ACCESS_DENIED" },
    });
  });

  it.each(["failure", "cancellation", "empty"])(
    "counts %s attempts without retries",
    async (kind) => {
      const failure =
        kind === "cancellation"
          ? new DOMException("Cancelled", "AbortError")
          : new Error("Unavailable");
      const { tool, execute } = fixture(async () => {
        if (kind !== "empty") throw failure;
        return result([]);
      });
      for (let index = 0; index < 8; index += 1) {
        const call = tool.execute({ query: "revenue" }, context());
        if (kind === "empty")
          await expect(call).resolves.toMatchObject({
            sources: [],
            budget: { used: index + 1 },
          });
        else await expect(call).rejects.toBe(failure);
      }
      await expect(
        tool.execute({ query: "revenue" }, context()),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(execute).toHaveBeenCalledTimes(8);
    },
  );

  it("rejects invalid or pre-cancelled requests without consuming budget", async () => {
    const { tool, execute } = fixture();
    for (const input of [
      {},
      { query: " " },
      { query: 1 },
      { query: "revenue", provider: "other" },
      { query: "revenue", maxResults: 10 },
      { query: "revenue", sourceRef: {} },
      "revenue",
    ]) {
      await expect(tool.execute(input, context())).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    const controller = new AbortController();
    const reason = new Error("Already cancelled");
    controller.abort(reason);
    await expect(
      tool.execute({ query: "revenue" }, context(controller.signal)),
    ).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      tool.execute({ query: "revenue" }, context()),
    ).resolves.toMatchObject({ budget: { used: 1 } });
  });

  it("preserves snippets above the target within the 50 percent allowance", async () => {
    const snippet = "🚀".repeat(2000);
    const { tool } = fixture(async () => result([{ ...source, snippet }]));
    const output = (await tool.execute({ query: "products" }, context())) as {
      sources: { snippet: string }[];
      truncated: boolean;
    };
    expect(output.sources[0]!.snippet).toBe(snippet);
    expect(output.truncated).toBe(false);
  });

  it("preserves all sources and truncates snippets without rewriting numeric text", async () => {
    const snippet = `${source.snippet}${"x".repeat(2400)}`;
    const saved = result(
      Array.from({ length: 6 }, () => ({ ...source, snippet })),
    );
    const { tool } = fixture(async () => saved);
    const output = (await tool.execute({ query: "revenue" }, context())) as {
      sources: { snippet: string }[];
      truncated: boolean;
    };
    expect(output.truncated).toBe(true);
    expect(output.sources).toHaveLength(6);
    expect(output.sources[0]!.snippet).toHaveLength(2400);
    expect(output.sources[0]!.snippet.startsWith(source.snippet!)).toBe(true);
    expect(saved.data.items).toHaveLength(6);
    expect(saved.data.items[0]!.snippet).toBe(snippet);
  });
});
