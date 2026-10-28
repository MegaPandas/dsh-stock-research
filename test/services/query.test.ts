import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { QueryCacheKey } from "../../src/contracts/cache.js";
import type {
  DataEnvelope,
  MarketData,
  ResearchScope,
} from "../../src/contracts/data.js";
import type { MarketSourceQuery } from "../../src/contracts/query.js";
import type {
  OpenRunInput,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { HttpClient } from "../../src/data/http.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { QueryService } from "../../src/services/query.js";
import type { QuerySources } from "../../src/services/query-sources.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { MARKET_FIXTURE, US_SECURITY } from "../fixtures/market.js";

const paths: string[] = [];
const roots: DataRoot[] = [];
const caches: SqliteCache[] = [];
const services: QueryService[] = [];
const releases: (() => void)[] = [];
const scope: ResearchScope = {
  security: US_SECURITY,
  date: "2024-01-08",
  cutoff: "2024-01-08T22:00:00.000Z",
};
const request: MarketSourceQuery = {
  dataset: "market",
  provider: "yahoo",
  parameters: { startDate: "2024-01-02", maxAgeMs: 1800000 },
};
const policy = {
  market: 60000,
  fundamentals: 60000,
  macro: 60000,
  research: 60000,
};
const capabilityHttp = new HttpClient({
  timeoutMs: 1000,
  maxConcurrency: 1,
  minIntervalMs: 0,
});
const capability = new YahooMarketAdapter(capabilityHttp).capability;
afterAll(() => capabilityHttp.close());
function result(): DataEnvelope<MarketData> {
  return {
    ...structuredClone(MARKET_FIXTURE),
    source: {
      provider: "yahoo",
      url: "https://example.invalid/market.json",
      adapterVersion: capability.adapterVersion,
      normalizationVersion: capability.normalizationVersion,
    },
    stale: true,
    gaps: [
      {
        code: "unverified_time",
        field: "/data",
        detail: "Source time is unverified",
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-query-test-"));
  paths.push(path);
  const root = new DataRoot(path);
  roots.push(root);
  const store = new RunStore<RunState>(root);
  const runs = new RunService(store, () => "2024-01-09T12:00:00.000Z");
  const cache = new SqliteCache({
    path: join(path, "cache.sqlite"),
    maxEntries: 100,
  });
  caches.push(cache);
  const query = vi.fn<YahooMarketAdapter["query"]>(async (input) => {
    const frame = result();
    return {
      ...frame,
      cutoff: input.scope.cutoff,
      ageMs: Date.parse(input.scope.cutoff) - Date.parse(frame.asOf),
    };
  });
  const sources: QuerySources = { yahoo: { capability, query } };
  function create(configured: QuerySources = sources) {
    const service = new QueryService(configured, cache, runs, policy);
    services.push(service);
    return service;
  }
  const service = create();
  const input: OpenRunInput = {
    definition: {
      scope,
      mode: "quick",
      tasks: ["a", "b"].map((id) => ({
        id,
        executor: { kind: "role", role: "analyst", specialty: "research" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      })),
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
  };
  const { runId } = runs.open("owner", input, "open");
  const claim = (taskId: string): TaskOperation => ({
    ...runs.claim({ runId, identity: "owner" }, taskId, `claim-${taskId}`),
    identity: "worker",
    sessionId: null,
  });
  return {
    path,
    root,
    store,
    runs,
    cache,
    query,
    sources,
    create,
    service,
    runId,
    op: claim("a"),
    claim,
  };
}
function cacheKey(override: Partial<QueryCacheKey> = {}): QueryCacheKey {
  return {
    provider: "yahoo",
    securityId: "US:NVDA",
    dataset: "market",
    cutoff: scope.cutoff,
    parameters: {
      date: scope.date,
      security: { ...scope.security },
      query: { ...request.parameters },
    },
    adapterVersion: capability.adapterVersion,
    normalizationVersion: capability.normalizationVersion,
    ...override,
  };
}
function gate(context: ReturnType<typeof setup>) {
  const started = deferred<AbortSignal | undefined>();
  const pending = deferred<DataEnvelope<MarketData>>();
  releases.push(() => pending.resolve(result()));
  context.query.mockImplementation(async (_input, signal) => {
    started.resolve(signal);
    return pending.promise;
  });
  return { started: started.promise, resolve: pending.resolve };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cache of caches.splice(0)) cache.close();
  for (const root of roots.splice(0)) root.close();
  for (const path of paths.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("query service composition", () => {
  it("rejects invalid cache durations at configuration", () => {
    const context = setup();
    for (const ttl of [-1, Number.NaN])
      expect(
        () =>
          new QueryService(context.sources, context.cache, context.runs, {
            ...policy,
            market: ttl,
          }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(context.query).not.toHaveBeenCalled();
  });
  it("loads and caches ordinary queries without registering evidence or adding run candidates", async () => {
    const { service, query, store, cache, runId } = setup();
    const saved = store.read(runId);
    const first = await service.query(scope, request);
    const second = await service.query(scope, request);
    expect(query).toHaveBeenCalledTimes(1);
    expect(first).toEqual(result());
    expect(second).toEqual(result());
    expect(second.retrievedAt).toBe("2024-01-08T22:00:00.000Z");
    expect(second.stale).toBe(true);
    expect(second.gaps).toEqual(result().gaps);
    expect(cache.get(cacheKey())).toEqual(result());
    expect(second).not.toHaveProperty("candidateClaims");
    expect(store.read(runId)).toEqual(saved);
  });

  it("separates complete parameters, scope and adapter normalization versions in cache identity", async () => {
    const { service, query, cache } = setup();
    cache.set(cacheKey({ adapterVersion: "old-adapter" }), result(), 60000);
    cache.set(
      cacheKey({ normalizationVersion: "old-normalization" }),
      result(),
      60000,
    );
    await service.query(scope, request);
    expect(query).toHaveBeenCalledTimes(1);
    await service.query(scope, {
      ...request,
      parameters: { ...request.parameters, maxAgeMs: 1 },
    });
    await service.query(
      { ...scope, date: "2024-01-09", cutoff: "2024-01-09T22:00:00.000Z" },
      request,
    );
    await service.query(
      { ...scope, security: { ...US_SECURITY, id: "US:AMD", symbol: "AMD" } },
      request,
    );
    expect(query).toHaveBeenCalledTimes(4);
    await service.query(scope, request);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("shares one raw source call but gives concurrent consumers independent results", async () => {
    const context = setup();
    const pending = gate(context);
    const a = context.service.query(scope, request);
    const b = context.service.query(scope, request);
    await pending.started;
    expect(context.query).toHaveBeenCalledTimes(1);
    pending.resolve(result());
    const [left, right] = await Promise.all([a, b]);
    left.data.bars[0]!.close = 999;
    expect(right.data.bars[0]!.close).toBe(10);
    expect(
      (await context.service.query(scope, request)).data.bars[0]!.close,
    ).toBe(10);
  });

  it("captures mutable scope and parameters before asynchronous loading", async () => {
    const context = setup();
    const pending = gate(context);
    const suppliedScope = structuredClone(scope);
    const suppliedRequest = structuredClone(request);
    const operation = context.service.query(suppliedScope, suppliedRequest);
    suppliedScope.security.symbol = "CHANGED";
    suppliedRequest.parameters.startDate = "2024-01-07";
    await pending.started;
    expect(context.query.mock.calls[0]![0]).toEqual({
      scope,
      ...request.parameters,
    });
    pending.resolve(result());
    await operation;
    expect(context.cache.get(cacheKey())).toEqual(result());
  });

  it("deduplicates the same task call, conflicts on changed parameters, and registers once", async () => {
    const context = setup();
    const pending = gate(context);
    const first = context.service.queryForTask(context.op, request, "data");
    const second = context.service.queryForTask(context.op, request, "data");
    await pending.started;
    await expect(
      context.service.queryForTask(
        context.op,
        { ...request, parameters: { ...request.parameters, maxAgeMs: 1 } },
        "data",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    pending.resolve(result());
    const [left, right] = await Promise.all([first, second]);
    expect(left.sourceRef).toEqual(right.sourceRef);
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(context.store.read(context.runId).evidence).toHaveLength(1);
    expect(left.envelope.candidateClaims.length).toBeGreaterThan(0);
    expect(left.envelope.candidateClaims[0]!.source.evidenceId).toBe(
      left.sourceRef.evidenceId,
    );
    expect(context.cache.get(cacheKey())).not.toHaveProperty("candidateClaims");
  });

  it("shares a source load for different task calls but gives each call a registered evidence identity", async () => {
    const context = setup();
    const pending = gate(context);
    const other = context.claim("b");
    const first = context.service.queryForTask(context.op, request, "first");
    const second = context.service.queryForTask(other, request, "second");
    await pending.started;
    pending.resolve(result());
    const [a, b] = await Promise.all([first, second]);
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(a.sourceRef.evidenceId).not.toBe(b.sourceRef.evidenceId);
    expect(context.store.read(context.runId).evidence).toHaveLength(2);
  });

  it("cancels one same-call waiter without cancelling another consumer or its evidence", async () => {
    const context = setup();
    const pending = gate(context);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const cancelled = context.service.queryForTask(
      context.op,
      request,
      "data",
      controller.signal,
    );
    const surviving = context.service.queryForTask(context.op, request, "data");
    const producerSignal = await pending.started;
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect(producerSignal!.aborted).toBe(false);
    pending.resolve(result());
    await surviving;
    expect(context.store.read(context.runId).evidence).toHaveLength(1);
    expect(context.query).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared source active when one of two task calls is cancelled", async () => {
    const context = setup();
    const pending = gate(context);
    const controller = new AbortController();
    const reason = new Error("first task query stopped");
    const first = context.service.queryForTask(
      context.op,
      request,
      "first",
      controller.signal,
    );
    const other = context.claim("b");
    const second = context.service.queryForTask(other, request, "second");
    const producer = await pending.started;
    const rejected = expect(first).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(producer!.aborted).toBe(false);
    pending.resolve(result());
    await second;
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(
      context.store.read(context.runId).evidence.map(({ taskId }) => taskId),
    ).toEqual(["b"]);
  });

  it("propagates a source error unchanged and never falls back to expired cached data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-01-09T12:00:00.000Z"));
    const context = setup();
    context.cache.set(cacheKey(), result(), 10);
    vi.setSystemTime(new Date("2024-01-09T12:00:00.011Z"));
    const underlying = new Error("offline");
    const failure = new ResearchError("SOURCE_UNAVAILABLE", "Yahoo failed", {
      cause: underlying,
    });
    context.query.mockRejectedValue(failure);
    await expect(
      context.service.queryForTask(context.op, request, "data"),
    ).rejects.toBe(failure);
    expect(failure.cause).toBe(underlying);
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(context.store.read(context.runId).evidence).toEqual([]);
    expect(context.cache.get(cacheKey())).toBeUndefined();
    expect(context.service.health(scope).sources[0]!.lastQuery).toEqual({
      at: "2024-01-09T12:00:00.011Z",
      outcome: "failed",
      errorCode: "SOURCE_UNAVAILABLE",
    });
  });

  it.each(["get", "set"] as const)(
    "propagates cache %s failure without publishing evidence",
    async (method) => {
      const context = setup();
      const failure = new Error(`cache ${method} failed`);
      vi.spyOn(context.cache, method).mockImplementation(() => {
        throw failure;
      });
      await expect(
        context.service.queryForTask(context.op, request, "data"),
      ).rejects.toBe(failure);
      expect(context.store.read(context.runId).evidence).toEqual([]);
      expect(
        context.store
          .read(context.runId)
          .receipts.some(({ action }) => action === "record_evidence"),
      ).toBe(false);
      expect(context.query).toHaveBeenCalledTimes(method === "get" ? 0 : 1);
    },
  );

  it("replays saved calls without a configured source while new calls fail explicitly", async () => {
    const context = setup();
    const saved = await context.service.queryForTask(
      context.op,
      request,
      "data",
    );
    const unconfigured = context.create({});
    expect(
      await unconfigured.queryForTask(context.op, request, "data"),
    ).toEqual(saved);
    await expect(
      unconfigured.queryForTask(context.op, request, "new"),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(context.query).toHaveBeenCalledTimes(1);
    expect(context.store.read(context.runId).evidence).toHaveLength(1);
  });

  it.each(["redo", "cancel"] as const)(
    "rejects registration when %s invalidates the attempt during fetching",
    async (transition) => {
      const context = setup();
      const pending = gate(context);
      const operation = context.service.queryForTask(
        context.op,
        request,
        "data",
      );
      await pending.started;
      const control = { runId: context.runId, identity: "owner" };
      if (transition === "redo") context.runs.redo(control, "a", "redo");
      else context.runs.cancel(control, "cancel");
      pending.resolve(result());
      await expect(operation).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
      expect(context.store.read(context.runId).evidence).toEqual([]);
      await expect(
        context.service.queryForTask(context.op, request, "new"),
      ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
      expect(context.query).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the original attempt binding when the caller reuses its operation object during fetching", async () => {
    const context = setup();
    const pending = gate(context);
    const operation = { ...context.op };
    const oldQuery = context.service.queryForTask(operation, request, "data");
    await pending.started;
    const control = { runId: context.runId, identity: "owner" };
    context.runs.redo(control, "a", "redo");
    const replacement = context.runs.claim(control, "a", "claim-a2");
    operation.attempt = replacement.attempt;
    operation.identity = "replacement-worker";
    operation.sessionId = "replacement-session";
    pending.resolve(result());
    await expect(oldQuery).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    const saved = context.store.read(context.runId);
    expect(saved.evidence).toEqual([]);
    expect(
      saved.tasks[0]!.attempts.map(({ number, status }) => [number, status]),
    ).toEqual([
      [1, "invalidated"],
      [2, "running"],
    ]);
    expect(
      saved.receipts.some(({ action }) => action === "record_evidence"),
    ).toBe(false);
    expect(context.query).toHaveBeenCalledTimes(1);
  });

  it("waits for its aborted loader to settle on close and never caches or registers a late result", async () => {
    const context = setup();
    const pending = gate(context);
    const operation = context.service.queryForTask(context.op, request, "data");
    const signal = await pending.started;
    const rejected = expect(operation).rejects.toMatchObject({
      name: "AbortError",
    });
    let closed = false;
    const closing = context.service.close().then(() => {
      closed = true;
    });
    expect(signal!.aborted).toBe(true);
    await rejected;
    expect(closed).toBe(false);
    pending.resolve(result());
    await closing;
    expect(context.cache.get(cacheKey())).toBeUndefined();
    expect(context.store.read(context.runId).evidence).toEqual([]);
    await expect(context.service.query(scope, request)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      context.service.queryForTask(context.op, request, "new"),
    ).rejects.toMatchObject({ name: "AbortError" });
    context.cache.set(cacheKey(), result(), 60000);
    expect(context.cache.get(cacheKey())).toEqual(result());
    expect(context.runs.view({ runId: context.runId }).status).toBe("active");
  });

  it("reports all eight profiles without source IO and returns independent health snapshots", async () => {
    const context = setup();
    const get = vi.spyOn(context.cache, "get");
    const set = vi.spyOn(context.cache, "set");
    const initial = context.service.health(scope);
    expect(initial.sources).toHaveLength(8);
    expect(
      initial.sources.filter(
        ({ capability: configured }) => configured !== null,
      ),
    ).toHaveLength(1);
    expect(
      initial.sources.every(
        ({ cacheHits, sourceCalls, lastQuery }) =>
          cacheHits === 0 && sourceCalls === 0 && lastQuery === null,
      ),
    ).toBe(true);
    expect(context.query).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    await context.service.query(scope, request);
    await context.service.query(scope, request);
    const health = context.service.health(scope);
    const yahoo = health.sources.find(
      ({ dataset, provider }) => dataset === "market" && provider === "yahoo",
    )!;
    expect(yahoo).toMatchObject({
      cacheHits: 1,
      sourceCalls: 1,
      lastQuery: {
        outcome: "succeeded",
        errorCode: null,
        at: expect.any(String),
      },
    });
    yahoo.cacheHits = 999;
    yahoo.lastQuery!.outcome = "failed";
    health.scope.security.symbol = "changed";
    expect(context.service.health(scope).sources[0]!.cacheHits).toBe(1);
    expect(context.service.health(scope).sources[0]!.lastQuery!.outcome).toBe(
      "succeeded",
    );
    expect(context.service.health(scope).scope.security.symbol).toBe("NVDA");
  });
});
