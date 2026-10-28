import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteCache } from "../../src/cache/index.js";
import type {
  DataEnvelope,
  MarketData,
  ResearchScope,
} from "../../src/contracts/data.js";
import type { IndicatorRequest } from "../../src/contracts/indicators.js";
import type {
  MarketIndicatorsQuery,
  MarketSourceQuery,
  PriceReturnsQuery,
} from "../../src/contracts/query.js";
import type { RunState } from "../../src/contracts/runs.js";
import { HttpClient } from "../../src/data/http.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import { QueryService } from "../../src/services/query.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { RunStore } from "../../src/runs/store.js";
import { RunService } from "../../src/services/runs.js";

const http = new HttpClient({
  timeoutMs: 1000,
  maxConcurrency: 1,
  minIntervalMs: 0,
});
const capability = new YahooMarketAdapter(http).capability;
afterAll(() => http.close());
const scope: ResearchScope = {
  security: {
    id: "US:NVDA",
    market: "US",
    symbol: "NVDA",
    exchange: "NASDAQ",
    currency: "USD",
    timeZone: "America/New_York",
  },
  date: "2024-01-08",
  cutoff: "2024-01-08T22:00:00.000Z",
};
const raw: MarketSourceQuery = {
  dataset: "market",
  provider: "yahoo",
  parameters: { startDate: "2024-01-02", maxAgeMs: 60_000 },
};
function indicators(requests: IndicatorRequest[]): MarketIndicatorsQuery {
  return { ...raw, parameters: { ...raw.parameters, indicators: requests } };
}
const returns: PriceReturnsQuery = {
  dataset: "returns",
  provider: "yahoo",
  parameters: {
    historyStartDate: "2024-01-02",
    startDate: "2024-01-04",
    endDate: "2024-01-07",
    maxAgeMs: 60_000,
    comparable: true,
  },
};
const cleanups: (() => Promise<void>)[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-derived-query-"));
  const root = new DataRoot(directory);
  const store = new RunStore<RunState>(root);
  const runs = new RunService(store, () => "2024-01-09T00:00:00.000Z");
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 10,
  });
  const market: MarketData = {
    currency: "USD",
    adjustment: "split_adjusted",
    bars: ["2024-01-02", "2024-01-03", "2024-01-05", "2024-01-08"].map(
      (date, index) => ({
        date,
        asOf: `${date}T21:00:00.000Z`,
        availableAt: null,
        sessionComplete: true,
        open: 10 + 4 * index,
        close: 10 + 4 * index,
        high: 11 + 4 * index,
        low: 9 + 4 * index,
        volume: index === 0 ? null : 100,
      }),
    ),
  };
  const query = vi.fn<YahooMarketAdapter["query"]>(async (input) => {
    const bars = structuredClone(
      market.bars.filter(
        (bar) => bar.date >= input.startDate && bar.date <= input.scope.date,
      ),
    );
    const asOf = bars.at(-1)?.asOf ?? input.scope.cutoff;
    const envelope: DataEnvelope<MarketData> = {
      dataset: "market",
      data: { ...market, bars },
      source: {
        provider: "yahoo",
        url: "https://example.com/derived-fixture",
        adapterVersion: capability.adapterVersion,
        normalizationVersion: capability.normalizationVersion,
      },
      asOf,
      availableAt: null,
      retrievedAt: "2024-01-09T00:00:00.000Z",
      cutoff: input.scope.cutoff,
      ageMs: Date.parse(input.scope.cutoff) - Date.parse(asOf),
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [
        {
          code: "unverified_time",
          field: "/data",
          detail: "Synthetic fixture; availability unverified.",
        },
      ],
    };
    if (bars[0]?.volume === null)
      envelope.gaps.push({
        code: "missing",
        field: "/data/bars/0/volume",
        detail: "Missing fixture volume.",
      });
    return envelope;
  });
  const policy = {
    market: 60_000,
    fundamentals: 60_000,
    macro: 60_000,
    research: 60_000,
  };
  const sources = { yahoo: { capability, query } };
  const service = new QueryService(sources, cache, runs, policy);
  const services = [service];
  const releases: (() => void)[] = [];
  cleanups.push(async () => {
    for (const release of releases) release();
    try {
      await Promise.all(services.map((entry) => entry.close()));
    } finally {
      try {
        cache.close();
      } finally {
        try {
          root.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  });
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          {
            id: "analysis",
            executor: { kind: "role", role: "analyst", specialty: "market" },
            dependsOn: [],
            inputTasks: [],
            outputKinds: ["analysis"],
            dataRequirements: [],
            instructionVersion: 1,
          },
        ],
      },
      versions: {
        plugin: "1",
        mode: "1",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "open",
  );
  const operation = {
    ...runs.claim({ runId, identity: "owner" }, "analysis", "claim"),
    identity: "worker",
    sessionId: null,
  };
  function pause() {
    const original = query.getMockImplementation()!;
    const started = deferred();
    const release = deferred();
    releases.push(() => release.resolve());
    query.mockImplementation(async (input, signal) => {
      started.resolve();
      await release.promise;
      return original(input, signal);
    });
    return { started: started.promise, release: () => release.resolve() };
  }
  return {
    service,
    services,
    cache,
    runs,
    store,
    runId,
    operation,
    market,
    query,
    policy,
    pause,
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("derived market queries", () => {
  it("retains aligned series, independent numeric expectations, versions and source metadata", async () => {
    const context = setup();
    const result = await context.service.query(
      scope,
      indicators([
        { kind: "sma", period: 2 },
        { kind: "boll", period: 2, deviations: 2 },
      ]),
    );
    expect(result.data.indicators).toEqual({
      algorithmVersion: "1",
      series: [
        {
          kind: "sma",
          period: 2,
          unit: "USD/share",
          values: [null, 12, 16, 20],
        },
        {
          kind: "boll",
          period: 2,
          deviations: 2,
          unit: "USD/share",
          values: [
            null,
            { middle: 12, upper: 16, lower: 8 },
            { middle: 16, upper: 20, lower: 12 },
            { middle: 20, upper: 24, lower: 16 },
          ],
        },
      ],
    });
    expect(result).toMatchObject({
      asOf: "2024-01-08T21:00:00.000Z",
      retrievedAt: "2024-01-09T00:00:00.000Z",
      cutoff: scope.cutoff,
      stale: true,
      historicalKnowledge: "unverified",
    });
    expect(result.gaps).toContainEqual({
      code: "missing",
      field: "/data/bars/0/volume",
      detail: "Missing fixture volume.",
    });
    expect(result.candidateClaims).toBeUndefined();
    expect(context.store.read(context.runId).evidence).toEqual([]);
    expect(context.query.mock.calls[0]![0]).toEqual({
      scope,
      ...raw.parameters,
    });
  });

  it("shares one raw source across plain, distinct indicator and return queries", async () => {
    const context = setup();
    const gate = context.pause();
    const requests = [
      context.service.query(scope, raw),
      context.service.query(scope, indicators([{ kind: "sma", period: 2 }])),
      context.service.query(scope, indicators([{ kind: "sma", period: 3 }])),
      context.service.query(scope, {
        ...returns,
        parameters: { ...returns.parameters, endDate: scope.date },
      }),
    ];
    await gate.started;
    gate.release();
    const result = await Promise.all(requests);
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(result[0]!.data).not.toHaveProperty("indicators");
    expect(result[1]!.data).toHaveProperty("indicators.series.0.values", [
      null,
      12,
      16,
      20,
    ]);
    expect(result[2]!.data).toHaveProperty("indicators.series.0.values", [
      null,
      null,
      14,
      18,
    ]);
    expect(result[3]!.data).toHaveProperty("value", 22 / 14 - 1);
    expect(context.market).not.toHaveProperty("indicators");
    expect((await context.service.query(scope, raw)).data).not.toHaveProperty(
      "indicators",
    );
    expect(context.query).toHaveBeenCalledTimes(1);
  });

  it("registers distinct latest indicator candidates with parameters, units and exact pointers", async () => {
    const context = setup();
    const request = indicators([
      { kind: "sma", period: 2 },
      { kind: "sma", period: 3 },
      { kind: "boll", period: 2, deviations: 2 },
      { kind: "macd", fastPeriod: 1, slowPeriod: 2, signalPeriod: 2 },
      { kind: "rsi", period: 2 },
    ]);
    const result = await context.service.queryForTask(
      context.operation,
      request,
      "indicators",
    );
    const candidates = result.envelope.candidateClaims.filter(
      ({ candidateId }) => candidateId.startsWith("indicators."),
    );
    expect(
      candidates.map(({ candidateId, value, unit, label, source }) => [
        candidateId,
        value,
        unit,
        label,
        source.selector,
      ]),
    ).toEqual([
      [
        "indicators.0.value",
        20,
        "USD/share",
        "2024-01-08 SMA(2) value",
        "/data/indicators/series/0/values/3",
      ],
      [
        "indicators.1.value",
        18,
        "USD/share",
        "2024-01-08 SMA(3) value",
        "/data/indicators/series/1/values/3",
      ],
      [
        "indicators.2.middle",
        20,
        "USD/share",
        "2024-01-08 BOLL(2,2) middle",
        "/data/indicators/series/2/values/3/middle",
      ],
      [
        "indicators.2.upper",
        24,
        "USD/share",
        "2024-01-08 BOLL(2,2) upper",
        "/data/indicators/series/2/values/3/upper",
      ],
      [
        "indicators.2.lower",
        16,
        "USD/share",
        "2024-01-08 BOLL(2,2) lower",
        "/data/indicators/series/2/values/3/lower",
      ],
      [
        "indicators.3.macd",
        2,
        "USD/share",
        "2024-01-08 MACD(1,2,2) macd",
        "/data/indicators/series/3/values/3/macd",
      ],
      [
        "indicators.3.signal",
        2,
        "USD/share",
        "2024-01-08 MACD(1,2,2) signal",
        "/data/indicators/series/3/values/3/signal",
      ],
      [
        "indicators.3.histogram",
        0,
        "USD/share",
        "2024-01-08 MACD(1,2,2) histogram",
        "/data/indicators/series/3/values/3/histogram",
      ],
      [
        "indicators.4.value",
        100,
        "index",
        "2024-01-08 RSI(2) value",
        "/data/indicators/series/4/values/3",
      ],
    ]);
    expect(
      candidates.every(
        ({ asOf, source }) =>
          asOf === "2024-01-08T21:00:00.000Z" &&
          source.evidenceId === result.sourceRef.evidenceId,
      ),
    ).toBe(true);
    expect(
      context.runs.readEvidence(result.sourceRef).request.parameters,
    ).toEqual(request.parameters);
  });

  it.each(["warmup", "latest missing"])(
    "does not replace %s indicator values with older numbers",
    async (condition) => {
      const context = setup();
      if (condition === "latest missing") context.market.bars[3]!.close = null;
      const result = await context.service.queryForTask(
        context.operation,
        indicators([{ kind: "sma", period: condition === "warmup" ? 5 : 2 }]),
        "indicators",
      );
      expect(
        result.envelope.data.indicators.series[0]!.values.at(-1),
      ).toBeNull();
      expect(
        result.envelope.candidateClaims.some(({ candidateId }) =>
          candidateId.startsWith("indicators."),
        ),
      ).toBe(false);
    },
  );

  it("keeps the available MACD component while its signal and histogram are warming up", async () => {
    const context = setup();
    context.market.bars = context.market.bars.slice(0, 2);
    const result = await context.service.queryForTask(
      context.operation,
      indicators([
        { kind: "macd", fastPeriod: 1, slowPeriod: 2, signalPeriod: 3 },
      ]),
      "indicators",
    );
    expect(
      result.envelope.candidateClaims
        .filter(({ candidateId }) => candidateId.startsWith("indicators."))
        .map(({ value, source }) => [value, source.selector]),
    ).toEqual([[2, "/data/indicators/series/0/values/1/macd"]]);
  });

  it("keeps task request identity separate from the shared raw cache and replays saved calculations", async () => {
    const context = setup();
    const request = indicators([{ kind: "sma", period: 2 }]);
    const saved = await context.service.queryForTask(
      context.operation,
      request,
      "indicators",
    );
    await expect(
      context.service.queryForTask(
        context.operation,
        indicators([{ kind: "sma", period: 3 }]),
        "indicators",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await context.service.queryForTask(
      context.operation,
      indicators([{ kind: "sma", period: 3 }]),
      "other",
    );
    const offline = new QueryService(
      {},
      context.cache,
      context.runs,
      context.policy,
    );
    context.services.push(offline);
    expect(
      await offline.queryForTask(context.operation, request, "indicators"),
    ).toEqual(saved);
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(context.store.read(context.runId).evidence).toHaveLength(2);
  });

  it("captures calculation parameters before awaiting raw data", async () => {
    const context = setup();
    const gate = context.pause();
    const request = indicators([{ kind: "sma", period: 2 }]);
    const pending = context.service.queryForTask(
      context.operation,
      request,
      "indicators",
    );
    await gate.started;
    request.parameters.indicators = [{ kind: "sma", period: 3 }];
    gate.release();
    const result = await pending;
    expect(result.envelope.data.indicators.series[0]).toMatchObject({
      period: 2,
      values: [null, 12, 16, 20],
    });
    expect(
      context.runs.readEvidence(result.sourceRef).request.parameters,
    ).toHaveProperty("indicators", [{ kind: "sma", period: 2 }]);
  });
});

describe("price-return query composition", () => {
  it("uses bounded prior sessions and preserves actual dates, prices, raw inputs and remapped gaps", async () => {
    const context = setup();
    const result = await context.service.queryForTask(
      context.operation,
      returns,
      "returns",
    );
    expect(context.query.mock.calls[0]![0]).toEqual({
      scope: { ...scope, date: "2024-01-07" },
      startDate: "2024-01-02",
      maxAgeMs: 60_000,
    });
    expect(result.envelope.dataset).toBe("returns");
    const data = result.envelope.data;
    expect(data).toMatchObject({
      algorithmVersion: "1",
      requestedStartDate: "2024-01-04",
      requestedEndDate: "2024-01-07",
      comparable: true,
      unit: "ratio",
      start: {
        date: "2024-01-03",
        price: 14,
        currency: "USD",
        adjustment: "split_adjusted",
      },
      end: { date: "2024-01-05", price: 18 },
    });
    expect(data.value).toBeCloseTo(2 / 7);
    expect(data.market.bars.map(({ date }) => date)).toEqual([
      "2024-01-02",
      "2024-01-03",
      "2024-01-05",
    ]);
    expect(result.envelope).toMatchObject({
      asOf: "2024-01-05T21:00:00.000Z",
      cutoff: scope.cutoff,
      retrievedAt: "2024-01-09T00:00:00.000Z",
      stale: true,
      historicalKnowledge: "unverified",
    });
    expect(result.envelope.gaps.map(({ field }) => field)).toEqual([
      "/data/market",
      "/data/market/bars/0/volume",
    ]);
    expect(
      result.envelope.candidateClaims.map(
        ({ candidateId, source, asOf, unit }) => [
          candidateId,
          source.selector,
          asOf,
          unit,
        ],
      ),
    ).toEqual([
      [
        "returns.start",
        "/data/start/price",
        "2024-01-03T21:00:00.000Z",
        "USD/share",
      ],
      [
        "returns.end",
        "/data/end/price",
        "2024-01-05T21:00:00.000Z",
        "USD/share",
      ],
      ["returns.value", "/data/value", "2024-01-05T21:00:00.000Z", "ratio"],
    ]);
  });

  it.each(["unconfirmed basis", "total-return adjusted"])(
    "returns an incomparable gap for %s",
    async (condition) => {
      const context = setup();
      if (condition === "total-return adjusted")
        context.market.adjustment = "total_return_adjusted";
      const request = {
        ...returns,
        parameters: {
          ...returns.parameters,
          comparable: condition !== "unconfirmed basis",
        },
      };
      const result = await context.service.queryForTask(
        context.operation,
        request,
        "returns",
      );
      expect(result.envelope.data.value).toBeNull();
      expect(result.envelope.gaps).toContainEqual(
        expect.objectContaining({ code: "incomparable", field: "/data/value" }),
      );
      expect(
        result.envelope.candidateClaims.map(({ candidateId }) => candidateId),
      ).toEqual(["returns.start", "returns.end"]);
    },
  );

  it.each(["missing start", "empty interval", "nearest close missing"])(
    "retains missing prices for %s",
    async (condition) => {
      const context = setup();
      const parameters = { ...returns.parameters };
      if (condition === "nearest close missing") {
        parameters.startDate = "2024-01-06";
        parameters.endDate = "2024-01-08";
        context.market.bars[2]!.close = null;
      } else {
        parameters.historyStartDate = "2024-01-04";
        if (condition === "empty interval") parameters.endDate = "2024-01-04";
      }
      const result = await context.service.query(scope, {
        ...returns,
        parameters,
      });
      expect(result.data.start).toBeNull();
      expect(result.data.end === null).toBe(condition === "empty interval");
      expect(result.data.value).toBeNull();
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ code: "missing", field: "/data/start" }),
      );
    },
  );

  it.each([
    { historyStartDate: "2024-01-05" },
    { startDate: "2024-01-08" },
    { endDate: "2024-01-09" },
  ])(
    "rejects a range outside its query or research bounds before fetching: %j",
    async (change) => {
      const context = setup();
      await expect(
        context.service.queryForTask(
          context.operation,
          { ...returns, parameters: { ...returns.parameters, ...change } },
          "returns",
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(context.query).not.toHaveBeenCalled();
      expect(context.store.read(context.runId).evidence).toEqual([]);
    },
  );

  it("rejects late derived evidence after redo and preserves the raw cache for a new attempt", async () => {
    const context = setup();
    const gate = context.pause();
    const pending = context.service.queryForTask(
      context.operation,
      returns,
      "returns",
    );
    await gate.started;
    context.runs.redo(
      { runId: context.runId, identity: "owner" },
      "analysis",
      "redo",
    );
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    expect(context.store.read(context.runId).evidence).toEqual([]);
    const next = {
      ...context.runs.claim(
        { runId: context.runId, identity: "owner" },
        "analysis",
        "claim-2",
      ),
      identity: "worker",
      sessionId: null,
    };
    await context.service.queryForTask(next, returns, "returns");
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(context.store.read(context.runId).evidence).toHaveLength(1);
  });
});
