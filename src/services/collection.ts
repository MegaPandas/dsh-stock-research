import { deriveFinancialMetrics } from "../data/financial-metrics.js";
import type { SqliteCache } from "../cache/index.js";
import { serializeJson } from "../cache/json.js";
import type {
  CollectedTableData,
  CollectionFailure,
  CollectionProgress,
  CollectionSnapshot,
  CollectionTask,
  CollectionAttempt,
  CollectionRecord,
} from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { QueryCachePolicy } from "../contracts/query.js";
import { getHttpRequestMetadata, type HttpClient } from "../data/http.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CollectionSnapshotStore } from "../storage/collection-snapshots.js";
import { collectionError, collectionErrorDetail } from "./collection-errors.js";
import { createChinaMarketTasks } from "../data/collection-market.js";
import { createChinaFinancialTasks } from "../data/collection-financials.js";
import { createChinaMacroTasks } from "../data/collection-macro.js";
import { createBenchmarkMarketTasks } from "../data/collection-benchmarks.js";
import { createBenchmarkBondTasks } from "../data/collection-bonds.js";
import { COLLECTION_VERSION } from "../data/collection-utils.js";
import type { QueryService } from "./query.js";
import { SharedQueries } from "./shared-queries.js";
import { createUsCollectionTasks } from "./collection-us.js";
import { applyCollectionFreshness } from "./collection-freshness.js";
import { XueqiuClient } from "../data/xueqiu.js";

export interface CollectionOptions {
  enabledSources: readonly string[];
  xueqiuCookie?: string;
  freshness: { market: number; fundamentals: number; macro: number };
  secCiks: Readonly<Record<string, string>>;
  ttl: QueryCachePolicy;
  requireDailyMarket?: boolean;
}

const REQUIRED_DATA_TIMEOUT_MS = 45_000;
const REQUIRED_RETRY_DELAY_MS = 2_000;
const ENDPOINT_FAILURE_THRESHOLD = 2;
const ENDPOINT_DEPRIORITIZE_MS = 60_000;
const DEFERRED_SOURCE = Symbol("deferred collection source");

function recoverable(cause: unknown): cause is Error {
  return (
    (cause instanceof ResearchError &&
      [
        "SOURCE_UNAVAILABLE",
        "DATA_INSUFFICIENT",
        "VERSION_UNAVAILABLE",
      ].includes(cause.code)) ||
    (cause instanceof Error &&
      (cause.name === "TimeoutError" ||
        (cause instanceof TypeError && cause.message === "fetch failed")))
  );
}

function endpointKey(task: CollectionTask): string {
  return `${task.provider}:${task.endpoint ?? task.id}`;
}

function taskCandidates(task: CollectionTask): CollectionTask[] {
  const candidates: CollectionTask[] = [];
  for (
    let candidate: CollectionTask | undefined = task;
    candidate !== undefined;
    candidate = candidate.fallback
  )
    candidates.push(candidate);
  return candidates;
}

async function waitForSource(previous: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

interface ProgressObservers {
  waiters: number;
  listeners: Set<(progress: CollectionProgress) => void>;
  latest?: CollectionProgress;
}

const CHINA_REUSABLE_TABLES = new Set([
  "market.daily",
  "market.weekly",
  "market.monthly",
  "market.averages",
  "valuation.history",
  "financial.indicators",
  "financial.quarter",
  "financial.income",
  "financial.balance",
  "financial.cashflow",
  "macro.gdp",
  "macro.cpi",
  "macro.ppi",
  "macro.pmi",
  "macro.moneySupply",
  "macro.lpr",
  "macro.industrial",
  "macro.retail",
  "macro.investment",
  "macro.trade",
  "macro.socialFinancing",
  "benchmark.bondYields",
  ...[
    "shanghai",
    "shenzhen",
    "csi300",
    "chinext",
    "gold",
    "dxy",
    "usdcny",
    "usdcnh",
    "eurusd",
    "usdjpy",
  ].flatMap((asset) =>
    ["daily", "weekly", "monthly"].map(
      (interval) => `benchmark.${asset}.${interval}`,
    ),
  ),
]);

// Existing CN tables use UTC midnight, CN market closes, CN day-end or UTC day-end
// as inclusion boundaries. Unknown tables and live quotes retain exact cutoffs.
function collectionCacheWindow(
  scope: ResearchScope,
  task: CollectionTask,
): string | undefined {
  if (scope.security.market !== "CN" || !CHINA_REUSABLE_TABLES.has(task.id))
    return undefined;
  const day = scope.cutoff.slice(0, 10);
  const boundaries = [
    "00:00:00.000",
    "07:00:00.000",
    "07:30:00.000",
    "15:59:59.999",
    "16:00:00.000",
    "23:59:59.999",
  ];
  return boundaries
    .map((time) => `${day}T${time}Z`)
    .filter((time) => time <= scope.cutoff)
    .at(-1)!;
}

/** All network decisions belong to this fixed recipe, before any analysis Agent exists. */
export class CollectionService {
  readonly #flights = new SharedQueries<CollectionSnapshot>();
  readonly #options: CollectionOptions;
  readonly #progress = new Map<string, ProgressObservers>();
  readonly #sourceTails = new Map<string, Promise<void>>();
  readonly #endpoints = new Map<
    string,
    { failures: number; retryAt: number }
  >();

  constructor(
    private readonly http: HttpClient,
    private readonly cache: SqliteCache,
    private readonly queries: Pick<QueryService, "query">,
    options: CollectionOptions,
    private readonly snapshots?: CollectionSnapshotStore,
  ) {
    this.#options = structuredClone(options);
  }

  async collect(
    scope: ResearchScope,
    signal?: AbortSignal,
    onProgress?: (progress: CollectionProgress) => void,
  ): Promise<CollectionSnapshot> {
    const captured = structuredClone(scope);
    const identity = serializeJson(captured);
    let observers = this.#progress.get(identity);
    if (observers === undefined) {
      observers = { waiters: 0, listeners: new Set() };
      this.#progress.set(identity, observers);
    }
    const capturedObservers = observers;
    const listener = (progress: CollectionProgress) => onProgress?.(progress);
    observers.waiters++;
    observers.listeners.add(listener);
    try {
      if (observers.latest !== undefined) listener(observers.latest);
      const result = await this.#flights.run(
        identity,
        identity,
        (active) =>
          this.execute(captured, active, (progress) => {
            capturedObservers.latest = progress;
            for (const notify of capturedObservers.listeners) notify(progress);
          }),
        signal,
      );
      return structuredClone(result);
    } finally {
      observers.listeners.delete(listener);
      observers.waiters--;
      if (observers.waiters === 0 && this.#progress.get(identity) === observers)
        this.#progress.delete(identity);
    }
  }

  close(): Promise<void> {
    return this.#flights.close();
  }

  finalizeScope(snapshot: CollectionSnapshot, scope: ResearchScope): void {
    snapshot.scope = structuredClone(scope);
    for (const packet of snapshot.packets) {
      const envelope = packet.envelope;
      envelope.cutoff = scope.cutoff;
      envelope.ageMs = Date.parse(scope.cutoff) - Date.parse(envelope.asOf);
      const dataset =
        packet.id === "valuation.history"
          ? "market"
          : (envelope.dataset as CollectionTask["dataset"]);
      applyCollectionFreshness(
        scope,
        envelope,
        this.#options.freshness[dataset],
      );
    }
  }

  private async execute(
    scope: ResearchScope,
    signal: AbortSignal,
    onProgress: (progress: CollectionProgress) => void,
  ): Promise<CollectionSnapshot> {
    const snapshot: CollectionSnapshot = {
      schemaVersion: 1,
      scope,
      packets: [],
      failures: [],
      diagnostics: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        cacheHits: 0,
        cacheMisses: 0,
        attempts: [],
      },
    };
    const enabled = new Set(this.#options.enabledSources);
    let tasks: CollectionTask[];
    if (scope.security.market === "CN") {
      const xueqiu = enabled.has("xueqiu")
        ? new XueqiuClient(
            this.http.forSource("xueqiu"),
            this.#options.xueqiuCookie!,
          )
        : undefined;
      tasks = [
        ...createChinaMarketTasks(this.http, scope, xueqiu),
        ...createChinaFinancialTasks(
          this.http.forSource("eastmoney"),
          scope,
          xueqiu,
        ),
        ...createChinaMacroTasks(this.http, scope),
        ...createBenchmarkMarketTasks(this.http, scope, xueqiu),
        ...createBenchmarkBondTasks(this.http.forSource("eastmoney"), scope),
      ].flatMap((task) => {
        const configured = task.id.startsWith("benchmark.")
          ? enabled.has("benchmarks")
          : task.id === "valuation.history"
            ? enabled.has("eastmoney-market")
            : task.dataset === "macro"
              ? enabled.has("china-macro")
              : task.dataset === "fundamentals"
                ? enabled.has("eastmoney-income")
                : task.id === "market.averages"
                  ? enabled.has("sina")
                  : enabled.has("eastmoney-market");
        const candidates = taskCandidates(task).filter((candidate, index) =>
          index === 0 ? configured : enabled.has(candidate.provider),
        );
        if (
          candidates.length > 0 &&
          (!task.id.startsWith("benchmark.") || configured)
        ) {
          let selected: CollectionTask | undefined;
          for (const candidate of candidates.reverse()) {
            const copy = { ...candidate };
            delete copy.fallback;
            if (selected !== undefined) copy.fallback = selected;
            selected = copy;
          }
          return [selected!];
        }
        snapshot.failures.push({
          id: task.id,
          provider: task.provider,
          code: "SOURCE_UNAVAILABLE",
          detail:
            "This dataset's fixed source is not enabled in the deployment.",
        });
        return [];
      });
    } else {
      tasks = createUsCollectionTasks(this.queries, scope, this.#options);
    }
    let succeeded = 0;
    let failed = 0;
    const total = tasks.length;
    const cache = { cacheHits: 0, cacheMisses: 0 };
    const attempts = snapshot.diagnostics!.attempts;
    const notify = (
      extra: Pick<
        CollectionProgress,
        "current" | "failures" | "recordPath"
      > = {},
    ) =>
      onProgress({
        total,
        completed: succeeded + failed,
        succeeded,
        failed,
        ...cache,
        ...extra,
      });
    const run = async (
      task: CollectionTask,
      active: AbortSignal,
      required = false,
    ) => {
      const failures: CollectionFailure[] = [];
      let reportedFailures = 0;
      const deadline = new AbortController();
      const timer = required
        ? setTimeout(
            () =>
              deadline.abort(
                new DOMException(
                  "Required daily collection exceeded its 45-second budget.",
                  "TimeoutError",
                ),
              ),
            REQUIRED_DATA_TIMEOUT_MS,
          )
        : undefined;
      const taskSignal = required
        ? AbortSignal.any([active, deadline.signal])
        : active;
      let envelope: DataEnvelope<CollectedTableData> | null = null;
      try {
        for (let round = 0; round < (required ? 2 : 1); round++) {
          taskSignal.throwIfAborted();
          const candidates = taskCandidates(task);
          for (const candidate of candidates) {
            const cached = this.cached(candidate, scope, cache);
            if (cached !== undefined) {
              envelope = cached;
              break;
            }
          }
          if (envelope !== null) break;
          candidates.sort(
            (left, right) => this.priority(left) - this.priority(right),
          );
          const deferred: CollectionTask[] = [];
          for (const [index, candidate] of candidates.entries()) {
            const result = await this.load(
              candidate,
              scope,
              taskSignal,
              failures,
              attempts,
              () =>
                notify({
                  current: { id: task.id, provider: candidate.provider },
                }),
              candidates.slice(index + 1),
            );
            if (result === DEFERRED_SOURCE) deferred.push(candidate);
            else envelope = result;
            if (envelope !== null) break;
          }
          if (envelope === null)
            for (const candidate of deferred) {
              const result = await this.load(
                candidate,
                scope,
                taskSignal,
                failures,
                attempts,
                () =>
                  notify({
                    current: { id: task.id, provider: candidate.provider },
                  }),
              );
              if (result !== DEFERRED_SOURCE) envelope = result;
              if (envelope !== null) break;
            }
          if (envelope !== null || !required || round === 1) break;
          if (
            !failures.some((failure) =>
              ["SOURCE_UNAVAILABLE", "TypeError", "TimeoutError"].includes(
                failure.code,
              ),
            )
          )
            break;
          notify({ failures: failures.slice() });
          reportedFailures = failures.length;
          await delay(REQUIRED_RETRY_DELAY_MS, undefined, {
            signal: taskSignal,
          });
        }
      } catch (cause) {
        if (!deadline.signal.aborted || active.aborted) throw cause;
        const last = attempts
          .filter((attempt) => attempt.id === task.id)
          .at(-1);
        const error = collectionError(deadline.signal.reason);
        failures.push({
          id: task.id,
          provider: last?.provider ?? task.provider,
          code: "TimeoutError",
          detail: collectionErrorDetail(error),
          error,
          ...(last?.endpoint === undefined ? {} : { endpoint: last.endpoint }),
        });
      } finally {
        clearTimeout(timer);
        snapshot.failures.push(...failures);
      }
      if (envelope !== null) {
        snapshot.packets.push({ id: task.id, envelope });
        succeeded++;
      } else failed++;
      notify(
        failures.length === reportedFailures
          ? {}
          : { failures: failures.slice(reportedFailures) },
      );
    };
    let problem: unknown;
    let executionFailed = false;
    let missingRequired = false;
    try {
      signal.throwIfAborted();
      if (this.#options.requireDailyMarket) {
        const daily = tasks.find((task) => task.id === "market.daily");
        if (daily !== undefined) await run(daily, signal, true);
        missingRequired = !snapshot.packets.some(
          (packet) => packet.id === "market.daily",
        );
        tasks = tasks.filter((task) => task.id !== "market.daily");
      }
      if (!missingRequired) {
        const stop = new AbortController();
        const active = AbortSignal.any([signal, stop.signal]);
        const results = await Promise.allSettled(
          tasks.map(async (task) => {
            try {
              await run(task, active);
            } catch (cause) {
              stop.abort(cause);
              throw cause;
            }
          }),
        );
        if (results.some((result) => result.status === "rejected"))
          throw stop.signal.reason;
        signal.throwIfAborted();
      }
    } catch (cause) {
      problem = cause;
      executionFailed = true;
    }
    const order = new Map(tasks.map((task, index) => [task.id, index]));
    snapshot.packets.sort(
      (left, right) => (order.get(left.id) ?? -1) - (order.get(right.id) ?? -1),
    );
    const metrics = deriveFinancialMetrics(scope, snapshot.packets);
    if (metrics) snapshot.packets.push(metrics);
    Object.assign(snapshot.diagnostics!, cache, {
      finishedAt: new Date().toISOString(),
    });
    const record: CollectionRecord = {
      schemaVersion: 1,
      status: signal.aborted
        ? "cancelled"
        : executionFailed
          ? "failed"
          : missingRequired
            ? "missing_required"
            : "complete",
      snapshot,
      ...(!executionFailed ? {} : { error: collectionError(problem) }),
    };
    try {
      const path = this.snapshots?.save(record);
      if (path !== undefined) {
        snapshot.recordPath = path;
        notify({ recordPath: path });
      }
    } catch (cause) {
      if (executionFailed)
        throw new AggregateError(
          [problem, cause],
          "Collection and snapshot persistence failed.",
          { cause },
        );
      throw cause;
    }
    if (executionFailed) throw problem;
    return snapshot;
  }

  private cacheKey(task: CollectionTask, scope: ResearchScope) {
    const budget =
      this.#options.freshness[
        task.id === "valuation.history" ? "market" : task.dataset
      ];
    const window = collectionCacheWindow(scope, task);
    return {
      provider: task.provider,
      dataset: task.dataset,
      securityId:
        window !== undefined &&
        (task.id.startsWith("macro.") || task.id.startsWith("benchmark."))
          ? "CN:shared"
          : scope.security.id,
      cutoff: window ?? scope.cutoff,
      parameters: {
        table: task.id,
        date: scope.date,
        freshness: budget,
        ...(window === undefined ? {} : { cacheWindow: "cn-segment-v1" }),
      },
      adapterVersion: COLLECTION_VERSION,
      normalizationVersion: COLLECTION_VERSION,
    };
  }

  private cached(
    task: CollectionTask,
    scope: ResearchScope,
    cacheStats: { cacheHits: number; cacheMisses: number },
  ): DataEnvelope<CollectedTableData> | undefined {
    const budget =
      this.#options.freshness[
        task.id === "valuation.history" ? "market" : task.dataset
      ];
    const key = this.cacheKey(task, scope);
    const cached = this.cache.get<CollectedTableData>(key);
    if (cached !== undefined && cached.cutoff <= scope.cutoff) {
      cacheStats.cacheHits++;
      cached.cutoff = scope.cutoff;
      cached.ageMs = Date.parse(scope.cutoff) - Date.parse(cached.asOf);
      applyCollectionFreshness(scope, cached, budget);
      return cached;
    }
    cacheStats.cacheMisses++;
    return undefined;
  }

  private priority(task: CollectionTask): number {
    return (this.#endpoints.get(endpointKey(task))?.retryAt ?? 0) > Date.now()
      ? 1
      : 0;
  }

  private async sourceRun<T>(
    provider: string,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#sourceTails.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#sourceTails.set(provider, tail);
    void tail.then(() => {
      if (this.#sourceTails.get(provider) === tail)
        this.#sourceTails.delete(provider);
    });
    try {
      await waitForSource(previous, signal);
      signal.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }

  private async load(
    task: CollectionTask,
    scope: ResearchScope,
    signal: AbortSignal,
    failures: CollectionFailure[],
    attempts: CollectionAttempt[],
    started: () => void,
    alternatives: readonly CollectionTask[] = [],
  ): Promise<DataEnvelope<CollectedTableData> | null | typeof DEFERRED_SOURCE> {
    return this.sourceRun(task.provider, signal, async () => {
      signal.throwIfAborted();
      if (
        alternatives.some(
          (alternative) => this.priority(task) > this.priority(alternative),
        )
      )
        return DEFERRED_SOURCE;
      started();
      const attempt =
        attempts.filter(
          (value) => value.id === task.id && value.provider === task.provider,
        ).length + 1;
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let envelope: DataEnvelope<CollectedTableData>;
      try {
        envelope = await task.run(signal);
      } catch (cause) {
        const error = collectionError(signal.aborted ? signal.reason : cause);
        const endpoint = getHttpRequestMetadata(cause)?.url ?? task.endpoint;
        const durationMs = Math.round(performance.now() - start);
        attempts.push({
          id: task.id,
          provider: task.provider,
          attempt,
          startedAt,
          durationMs,
          outcome: signal.aborted ? "cancelled" : "failed",
          error,
          ...(endpoint === undefined ? {} : { endpoint }),
        });
        signal.throwIfAborted();
        if (!recoverable(cause)) throw cause;
        failures.push({
          id: task.id,
          provider: task.provider,
          code: cause instanceof ResearchError ? cause.code : cause.name,
          detail: collectionErrorDetail(error),
          error,
          attempt,
          durationMs,
          ...(endpoint === undefined ? {} : { endpoint }),
        });
        if (
          !(cause instanceof ResearchError) ||
          cause.code === "SOURCE_UNAVAILABLE"
        ) {
          const key = endpointKey(task);
          const count = (this.#endpoints.get(key)?.failures ?? 0) + 1;
          this.#endpoints.set(key, {
            failures: count,
            retryAt:
              count >= ENDPOINT_FAILURE_THRESHOLD
                ? Date.now() + ENDPOINT_DEPRIORITIZE_MS
                : 0,
          });
        }
        return null;
      }
      signal.throwIfAborted();
      attempts.push({
        id: task.id,
        provider: task.provider,
        attempt,
        startedAt,
        durationMs: Math.round(performance.now() - start),
        outcome: "success",
        endpoint: task.endpoint ?? envelope.source.url.split(/[?#]/, 1)[0]!,
      });
      this.#endpoints.delete(endpointKey(task));
      this.cache.set(
        this.cacheKey(task, scope),
        envelope,
        this.#options.ttl[task.dataset],
      );
      applyCollectionFreshness(
        scope,
        envelope,
        this.#options.freshness[
          task.id === "valuation.history" ? "market" : task.dataset
        ],
      );
      return envelope;
    });
  }
}
