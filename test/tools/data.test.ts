import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ToolRuntime,
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { DataEnvelope, MarketData } from "../../src/contracts/data.js";
import { EastmoneyIncomeAdapter } from "../../src/data/eastmoney-income.js";
import { EastmoneyMarketAdapter } from "../../src/data/eastmoney-market.js";
import { FredCsvAdapter } from "../../src/data/fred-csv.js";
import { HostResearchAdapter } from "../../src/data/host-research.js";
import { HttpClient } from "../../src/data/http.js";
import { SecConceptAdapter } from "../../src/data/sec-concept.js";
import { SinaIncomeAdapter } from "../../src/data/sina-income.js";
import { TencentMarketAdapter } from "../../src/data/tencent-market.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import {
  SessionBindings,
  type ResearchBinding,
} from "../../src/host/bindings.js";
import { QueryService } from "../../src/services/query.js";
import { TaskQueryService } from "../../src/services/task-query.js";
import { createDataTools } from "../../src/tools/data.js";
import {
  dataSchemas,
  type QueryToolPolicy,
} from "../../src/tools/query-inputs.js";
import { decisionFixture } from "../fixtures/decision.js";
import { CN_SECURITY, MARKET_FIXTURE } from "../fixtures/market.js";

const cleanups: (() => void | Promise<void>)[] = [];
const marketArgs = { provider: "yahoo", startDate: "2024-01-02" };
const returnArgs = {
  provider: "yahoo",
  historyStartDate: "2024-01-02",
  startDate: "2024-01-02",
  endDate: "2024-01-03",
};
const secArgs = {
  provider: "sec",
  field: "netIncome",
  periodEndFrom: "2023-01-01",
};
function setup(mapped = true) {
  const f = decisionFixture({
    additionalTasks: [
      {
        id: "reader",
        executor: { kind: "role", role: "analyst", specialty: "reader" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ],
  });
  const claim = f.runs.claim(f.operation, "reader", "claim-reader");
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const sources = {
    yahoo: new YahooMarketAdapter(http),
    eastmoneyMarket: new EastmoneyMarketAdapter(http),
    tencent: new TencentMarketAdapter(http),
    sec: new SecConceptAdapter(http, "Test/1"),
    eastmoneyIncome: new EastmoneyIncomeAdapter(http),
    sina: new SinaIncomeAdapter(http),
    fred: new FredCsvAdapter(http),
    research: new HostResearchAdapter(async () => {
      throw new Error("Unexpected host search");
    }),
  };
  const frame: DataEnvelope<MarketData> = {
    ...structuredClone(MARKET_FIXTURE),
    cutoff: f.scope.cutoff,
    asOf: "2024-01-03T21:00:00.000Z",
    retrievedAt: f.scope.cutoff,
    data: {
      ...MARKET_FIXTURE.data,
      bars: MARKET_FIXTURE.data.bars.slice(0, 2),
    },
  };
  function envelope<T>(
    key: keyof typeof sources,
    dataset: DataEnvelope<T>["dataset"],
    data: T,
  ): DataEnvelope<T> {
    return {
      ...frame,
      dataset,
      data,
      source: { ...frame.source, ...sources[key].capability },
    };
  }
  const spies = {
    yahoo: vi
      .spyOn(sources.yahoo, "query")
      .mockResolvedValue(envelope("yahoo", "market", frame.data)),
    eastmoneyMarket: vi
      .spyOn(sources.eastmoneyMarket, "query")
      .mockResolvedValue(envelope("eastmoneyMarket", "market", frame.data)),
    tencent: vi
      .spyOn(sources.tencent, "query")
      .mockResolvedValue(envelope("tencent", "market", frame.data)),
    sec: vi.spyOn(sources.sec, "query").mockResolvedValue(
      envelope("sec", "fundamentals", {
        field: "netIncome" as const,
        currency: "USD",
        concept: { taxonomy: "us-gaap", tag: "NetIncomeLoss" },
        observations: [],
      }),
    ),
    eastmoneyIncome: vi
      .spyOn(sources.eastmoneyIncome, "query")
      .mockResolvedValue(
        envelope("eastmoneyIncome", "fundamentals", {
          currency: "CNY",
          basis: "year_to_date" as const,
          fields: [
            "totalOperatingRevenue" as const,
            "netIncomeToParent" as const,
          ],
          observations: [],
        }),
      ),
    sina: vi.spyOn(sources.sina, "query").mockResolvedValue(
      envelope("sina", "fundamentals", {
        currency: "CNY",
        basis: "year_to_date" as const,
        consolidation: "consolidated" as const,
        fields: ["revenue" as const, "netIncome" as const],
        observations: [],
      }),
    ),
    fred: vi.spyOn(sources.fred, "query").mockResolvedValue(
      envelope("fred", "macro", {
        seriesId: "DGS10" as const,
        unit: "percent" as const,
        frequency: "daily" as const,
        seasonalAdjustment: "not_seasonally_adjusted" as const,
        view: "current" as const,
        observations: [],
      }),
    ),
    research: vi.spyOn(sources.research, "query").mockResolvedValue(
      envelope("research", "research", {
        query: "NVDA",
        view: "current_search" as const,
        truncated: false,
        items: [],
      }),
    ),
  };
  const cache = new SqliteCache({ path: ":memory:", maxEntries: 100 });
  const queries = new QueryService(sources, cache, {
    market: 60000,
    fundamentals: 60000,
    macro: 60000,
    research: 60000,
  });
  const taskQueries = new TaskQueryService(queries, f.runs);
  const bindings = new SessionBindings();
  const secCiks: Record<string, string> = mapped
    ? { "US:NVDA": "0001045810" }
    : {};
  const policy = {
    freshness: { market: 11, fundamentals: 22, macro: 33 },
    secCiks,
  } satisfies QueryToolPolicy;
  const tools = createDataTools(
    { runs: f.runs, queries, taskQueries },
    bindings,
    policy,
  );
  let agentSequence = 0;
  function agent(binding: ResearchBinding) {
    const caller = { id: `data-agent-${++agentSequence}` } as Agent;
    bindings.bind(caller, binding);
    return caller;
  }
  const task = agent({
    kind: "task",
    runId: f.operation.runId,
    taskId: "reader",
    attempt: claim.attempt,
  });
  const ask = agent({ kind: "ask", scope: f.scope });
  const review = agent({
    kind: "review",
    runId: f.operation.runId,
    scope: f.scope,
  });
  const call = (
    name: string,
    args: unknown,
    caller = task,
    callId = "call",
    signal = new AbortController().signal,
  ) =>
    tools
      .find((tool) => tool.name === name)!
      .execute(args, { agent: caller, callId, signal } as ToolRunContext);
  cleanups.push(async () => {
    await Promise.all([taskQueries.close(), queries.close()]);
    cache.close();
    await http.close();
    f.close();
  });
  return {
    ...f,
    sources,
    spies,
    frame,
    queries,
    policy,
    tools,
    task,
    ask,
    review,
    agent,
    call,
  };
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

describe("data tools", () => {
  it("exposes fundamentals provider fields in one object and preserves provider contracts", async () => {
    const schema = dataSchemas.stock_get_fundamentals;
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(Object.keys(schema.properties!)).toEqual([
      "provider",
      "field",
      "fields",
      "periodEndFrom",
      "periodEndTo",
      "source",
    ]);
    for (const args of [
      secArgs,
      {
        provider: "eastmoney",
        fields: ["netIncomeToParent"],
        periodEndFrom: "2023-01-01",
        periodEndTo: "2023-12-31",
      },
      { provider: "sina", fields: ["netIncome"] },
    ])
      expect(validateJsonSchemaValue(schema, args)).toEqual([]);
    const f = setup();
    for (const args of [
      { ...secArgs, fields: ["netIncome"] },
      {
        provider: "eastmoney",
        fields: ["netIncome"],
        periodEndFrom: "2023-01-01",
        periodEndTo: "2023-12-31",
      },
      { provider: "sina", fields: ["netIncome"], periodEndFrom: "2023-01-01" },
    ])
      await expect(
        f.call("stock_get_fundamentals", args),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("registers and executes all five SDK tools with valid output schemas", async () => {
    const f = setup();
    const ctx = new Context();
    const release = ctx.provide("systemPrompt", {
      tools: () => () => {},
    } as never);
    const runtime = new ToolRuntime(ctx, { mode: "native" });
    const unregister = f.tools.map((tool) => runtime.register(tool));
    cleanups.push(() => {
      unregister.reverse().forEach((fn) => fn());
      release();
    });
    for (const [name, args] of [
      ["stock_get_market", marketArgs],
      ["stock_get_fundamentals", secArgs],
      [
        "stock_get_macro",
        {
          provider: "fred",
          seriesId: "DGS10",
          startDate: "2024-01-02",
          endDate: "2024-01-03",
        },
      ],
      ["stock_get_returns", returnArgs],
      ["stock_research", { provider: "dsh-web", query: "NVDA", maxResults: 2 }],
    ] as const) {
      const result = await runtime.execute({
        name,
        arguments: args,
        agent: f.task,
        callId: name as ToolRunContext["callId"],
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      if (result.isError) throw new Error(JSON.stringify(result.error));
      expect(result.value).toMatchObject({
        kind: "task",
        sourceRef: { runId: f.operation.runId },
      });
    }
  });
  it("routes all eight sources with bound scope and captured freshness", async () => {
    const f = setup();
    const cnScope = { ...f.scope, security: CN_SECURITY };
    const cnAsk = f.agent({ kind: "ask", scope: cnScope });
    for (const key of ["eastmoneyMarket", "tencent"] as const)
      f.spies[key].mockResolvedValue({
        ...f.frame,
        source: { ...f.frame.source, ...f.sources[key].capability },
        data: { ...f.frame.data, currency: "CNY" },
      });
    f.policy.freshness.market = 999;
    f.policy.secCiks["US:NVDA"] = "0000000001";
    const routes = [
      [
        "stock_get_market",
        marketArgs,
        "yahoo",
        { startDate: "2024-01-02", maxAgeMs: 11 },
      ],
      [
        "stock_get_market",
        { ...marketArgs, provider: "eastmoney" },
        "eastmoneyMarket",
        { maxAgeMs: 11 },
      ],
      [
        "stock_get_market",
        { ...marketArgs, provider: "tencent" },
        "tencent",
        { maxAgeMs: 11 },
      ],
      [
        "stock_get_fundamentals",
        secArgs,
        "sec",
        { cik: "0001045810", field: "netIncome", maxAgeMs: 22 },
      ],
      [
        "stock_get_fundamentals",
        {
          provider: "eastmoney",
          fields: ["totalOperatingRevenue", "netIncomeToParent"],
          periodEndFrom: "2023-01-01",
          periodEndTo: "2023-12-31",
        },
        "eastmoneyIncome",
        {
          fields: ["totalOperatingRevenue", "netIncomeToParent"],
          maxAgeMs: 22,
        },
      ],
      [
        "stock_get_fundamentals",
        {
          provider: "sina",
          fields: [
            "revenue",
            "totalOperatingRevenue",
            "netIncome",
            "netIncomeToParent",
          ],
        },
        "sina",
        {
          fields: [
            "revenue",
            "totalOperatingRevenue",
            "netIncome",
            "netIncomeToParent",
          ],
          maxAgeMs: 22,
        },
      ],
      [
        "stock_get_macro",
        {
          provider: "fred",
          seriesId: "DGS10",
          startDate: "2024-01-02",
          endDate: "2024-01-03",
        },
        "fred",
        { maxAgeMs: 33 },
      ],
      [
        "stock_research",
        { provider: "dsh-web", query: "NVDA", maxResults: 2 },
        "research",
        { query: "NVDA", maxResults: 2 },
      ],
    ] as const;
    for (const [name, args, key, expected] of routes) {
      const cnSource = [
        "eastmoneyMarket",
        "tencent",
        "eastmoneyIncome",
        "sina",
      ].includes(key);
      const scope = cnSource ? cnScope : f.scope;
      await f.call(name, args, cnSource ? cnAsk : f.ask);
      expect(f.spies[key]).toHaveBeenCalledWith(
        expect.objectContaining({ ...expected, scope }),
        expect.any(AbortSignal),
      );
    }
  });
  it("requires trusted SEC issuer mapping before fetching", async () => {
    const f = setup(false);
    await expect(
      f.call("stock_get_fundamentals", secArgs),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    expect(f.spies.sec).not.toHaveBeenCalled();
  });
  it.each([
    "cik",
    "maxAgeMs",
    "comparable",
    "runId",
    "cutoff",
    "security",
    "requestId",
  ])("rejects model override %s before fetching", async (key) => {
    const f = setup();
    await expect(
      f.call("stock_get_market", { ...marketArgs, [key]: "override" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.spies.yahoo).not.toHaveBeenCalled();
  });
  it("rejects SEC cik overrides", async () => {
    const f = setup();
    await expect(
      f.call("stock_get_fundamentals", { ...secArgs, cik: "0000000001" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.spies.sec).not.toHaveBeenCalled();
  });
  it("rejects invalid dates, reversed ranges and dates beyond bound scope", async () => {
    const f = setup();
    for (const args of [
      { ...returnArgs, startDate: "2024-02-30" },
      { ...returnArgs, startDate: "2024-1-02" },
      { ...returnArgs, endDate: "2024-01-01" },
      { ...returnArgs, endDate: "2024-01-04" },
    ])
      await expect(f.call("stock_get_returns", args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    expect(f.spies.yahoo).not.toHaveBeenCalled();
  });
  it("rejects bad indicators and closed nested indicator fields", async () => {
    const f = setup();
    for (const indicator of [
      { kind: "sma", period: 0 },
      { kind: "macd", fastPeriod: 10, slowPeriod: 5, signalPeriod: 2 },
      { kind: "boll", period: 2, deviations: -1 },
      { kind: "unknown", period: 2 },
      { kind: "sma", period: 2, extra: true },
    ])
      await expect(
        f.call("stock_get_market", { ...marketArgs, indicators: [indicator] }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.spies.yahoo).not.toHaveBeenCalled();
  });
  it("rejects unsupported fields, providers and malformed saved sources", async () => {
    const f = setup();
    for (const [name, args] of [
      ["stock_get_fundamentals", { ...secArgs, field: "profit" }],
      ["stock_get_fundamentals", { provider: "sina", fields: ["unknown"] }],
      ["stock_get_market", { ...marketArgs, provider: "auto" }],
      [
        "stock_get_market",
        {
          ...marketArgs,
          source: { runId: "x", evidenceId: "y", selector: "/data" },
        },
      ],
      [
        "stock_get_market",
        { ...marketArgs, source: { runId: "", evidenceId: "y" } },
      ],
    ] as const)
      await expect(f.call(name, args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    expect(
      Object.values(f.spies).every((spy) => spy.mock.calls.length === 0),
    ).toBe(true);
  });
  it("registers evidence before returning and replays the exec.callId receipt", async () => {
    const f = setup();
    const first = await f.call(
      "stock_get_market",
      marketArgs,
      f.task,
      "receipt",
    );
    expect(first).toMatchObject({ kind: "task" });
    const ref = (
      first as {
        sourceRef: { runId: string; evidenceId: string; selector: string };
      }
    ).sourceRef;
    expect(f.runs.readEvidence(ref).envelope.data).toEqual(f.frame.data);
    expect(
      await f.call("stock_get_market", marketArgs, f.task, "receipt"),
    ).toEqual(first);
    expect(f.spies.yahoo).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent calls with the same task callId", async () => {
    const f = setup();
    const [a, b] = await Promise.all([
      f.call("stock_get_market", marketArgs),
      f.call("stock_get_market", marketArgs),
    ]);
    expect(a).toEqual(b);
    expect(f.spies.yahoo).toHaveBeenCalledTimes(1);
  });
  it("keeps ask queries ordinary without registering evidence", async () => {
    const f = setup();
    const before = f.store.read(f.operation.runId);
    await expect(
      f.call("stock_get_market", marketArgs, f.ask),
    ).resolves.toMatchObject({ kind: "ordinary" });
    expect(f.store.read(f.operation.runId)).toEqual(before);
  });
  it("permits review market and returns only", async () => {
    const f = setup();
    await expect(
      f.call("stock_get_market", marketArgs, f.review),
    ).resolves.toMatchObject({ kind: "ordinary" });
    await expect(
      f.call("stock_get_returns", returnArgs, f.review),
    ).resolves.toMatchObject({ kind: "ordinary" });
    for (const name of [
      "stock_get_fundamentals",
      "stock_get_macro",
      "stock_research",
    ])
      await expect(f.call(name, {}, f.review)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
  });
  it("denies coordinator data access", async () => {
    const f = setup();
    const caller = f.agent({
      kind: "coordinator",
      runIds: [f.operation.runId],
    });
    await expect(
      f.call("stock_get_market", marketArgs, caller),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(f.spies.yahoo).not.toHaveBeenCalled();
  });
  it("preserves return endpoints while leaving unverified comparability and value null", async () => {
    const f = setup();
    const result = await f.call("stock_get_returns", returnArgs, f.ask);
    expect(result).toMatchObject({
      envelope: {
        data: {
          start: { date: "2024-01-02", price: 10 },
          end: { date: "2024-01-03", price: 12 },
          comparable: false,
          value: null,
        },
        gaps: expect.arrayContaining([
          expect.objectContaining({ code: "incomparable" }),
        ]),
      },
    });
    f.spies.yahoo.mockResolvedValue({
      ...f.frame,
      data: { ...f.frame.data, bars: [] },
    });
    await expect(
      f.call(
        "stock_get_returns",
        { ...returnArgs, historyStartDate: "2024-01-01" },
        f.ask,
      ),
    ).resolves.toMatchObject({
      envelope: {
        data: { start: null, end: null, comparable: false, value: null },
        gaps: expect.arrayContaining([
          expect.objectContaining({ code: "missing", field: "/data/start" }),
          expect.objectContaining({ code: "missing", field: "/data/end" }),
        ]),
      },
    });
  });
  it("replays explicit saved evidence for offline derived returns", async () => {
    const f = setup();
    const saved = await f.call("stock_get_returns", returnArgs);
    const source = (
      saved as { sourceRef: { runId: string; evidenceId: string } }
    ).sourceRef;
    const state = f.store.read(f.operation.runId);
    const replay = f.runs.open(
      "owner",
      { replay: { runId: f.operation.runId }, versions: state.versions },
      "replay",
    );
    const claim = f.runs.claim(
      { runId: replay.runId, identity: "owner" },
      "reader",
      "claim-replay",
    );
    const caller = f.agent({
      kind: "task",
      runId: replay.runId,
      taskId: "reader",
      attempt: claim.attempt,
    });
    f.spies.yahoo.mockRejectedValue(new Error("Offline"));
    await expect(
      f.call(
        "stock_get_returns",
        {
          ...returnArgs,
          source: { runId: source.runId, evidenceId: source.evidenceId },
        },
        caller,
        "derived",
      ),
    ).resolves.toMatchObject({
      kind: "task",
      envelope: { data: { value: null, comparable: false } },
    });
    expect(f.spies.yahoo).toHaveBeenCalledTimes(1);
  });
  it("propagates cancellation through the source signal without publishing", async () => {
    const f = setup();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.spies.yahoo.mockImplementation(async (_input, signal) => {
      started();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    });
    const before = f.store.read(f.operation.runId);
    const pending = f.call(
      "stock_get_market",
      marketArgs,
      f.task,
      "cancel",
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
    expect(f.store.read(f.operation.runId)).toEqual(before);
    expect(f.spies.eastmoneyMarket).not.toHaveBeenCalled();
  });
  it("rejects pre-cancelled calls before fetching", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.call(
        "stock_get_market",
        marketArgs,
        f.task,
        "cancel",
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(f.spies.yahoo).not.toHaveBeenCalled();
  });
  it("propagates source errors without publishing or falling back", async () => {
    const f = setup();
    const error = new Error("Source failed");
    f.spies.yahoo.mockRejectedValue(error);
    const before = f.store.read(f.operation.runId);
    await expect(f.call("stock_get_market", marketArgs)).rejects.toBe(error);
    expect(f.store.read(f.operation.runId)).toEqual(before);
    expect(f.spies.eastmoneyMarket).not.toHaveBeenCalled();
    expect(f.spies.tencent).not.toHaveBeenCalled();
  });
});
