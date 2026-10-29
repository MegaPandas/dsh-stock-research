import { deriveFinancialMetrics } from "../data/financial-metrics.js";
import type { SqliteCache } from "../cache/index.js";
import { serializeJson } from "../cache/json.js";
import type {
  CollectionDiagnostics,
  CollectionOptions,
  CollectionPlan,
  CollectionProgress,
  CollectionSnapshot,
  CollectionRecord,
  CollectionDataset,
} from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import type { HttpClient } from "../data/http.js";
import type { CollectionSnapshotStore } from "../storage/collection-snapshots.js";
import { collectionError } from "./collection-errors.js";
import { createCollectionPlans } from "./collection-plan.js";
import { CollectionCache } from "./collection-cache.js";
import { CollectionSourceRunner } from "./collection-source.js";
import { CollectionTableRunner } from "./collection-table.js";
import type { QueryService } from "./query.js";
import { SharedQueries } from "./shared-queries.js";
import { applyCollectionFreshness } from "./collection-freshness.js";

interface ProgressObservers {
  waiters: number;
  listeners: Set<(progress: CollectionProgress) => void>;
  latest?: CollectionProgress;
}

/** Own a collection's lifecycle, progress and durable snapshot. */
export class CollectionService {
  readonly #flights = new SharedQueries<CollectionSnapshot>();
  readonly #options: CollectionOptions;
  readonly #progress = new Map<string, ProgressObservers>();
  readonly #tables: CollectionTableRunner;

  constructor(
    private readonly http: HttpClient,
    cache: SqliteCache,
    private readonly queries: Pick<QueryService, "query">,
    options: CollectionOptions,
    private readonly snapshots?: CollectionSnapshotStore,
  ) {
    this.#options = structuredClone(options);
    this.#tables = new CollectionTableRunner(
      new CollectionCache(cache, this.#options),
      new CollectionSourceRunner(),
    );
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
          : (envelope.dataset as CollectionDataset);
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
    const diagnostics: CollectionDiagnostics = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      cacheHits: 0,
      cacheMisses: 0,
      attempts: [],
    };
    const { plans, disabled } = createCollectionPlans(
      this.http,
      this.queries,
      scope,
      this.#options,
    );
    const snapshot: CollectionSnapshot = {
      schemaVersion: 1,
      scope,
      packets: [],
      failures: disabled,
      diagnostics,
    };
    let succeeded = 0;
    let failed = 0;
    const notify = (
      extra: Pick<
        CollectionProgress,
        "current" | "failures" | "recordPath"
      > = {},
    ) =>
      onProgress({
        total: plans.length,
        completed: succeeded + failed,
        succeeded,
        failed,
        cacheHits: diagnostics.cacheHits,
        cacheMisses: diagnostics.cacheMisses,
        ...extra,
      });
    const run = async (plan: CollectionPlan, active: AbortSignal) => {
      const result = await this.#tables.collect(plan, scope, {
        signal: active,
        diagnostics,
        failures: snapshot.failures,
        notify,
      });
      if (result.status === "unavailable") failed++;
      else {
        snapshot.packets.push({ id: plan.id, envelope: result.envelope });
        succeeded++;
      }
      notify(result.failures.length === 0 ? {} : { failures: result.failures });
    };

    let problem: unknown;
    let executionFailed = false;
    let missingRequired = false;
    try {
      signal.throwIfAborted();
      for (const plan of plans.filter((plan) => plan.required)) {
        await run(plan, signal);
      }
      missingRequired =
        this.#options.requireDailyMarket === true &&
        !snapshot.packets.some((packet) => packet.id === "market.daily");
      if (!missingRequired) {
        const stop = new AbortController();
        const active = AbortSignal.any([signal, stop.signal]);
        const results = await Promise.allSettled(
          plans
            .filter((plan) => !plan.required)
            .map(async (plan) => {
              try {
                await run(plan, active);
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

    const order = new Map(plans.map((plan, index) => [plan.id, index]));
    snapshot.packets.sort(
      (left, right) => order.get(left.id)! - order.get(right.id)!,
    );
    const metrics = deriveFinancialMetrics(scope, snapshot.packets);
    if (metrics) snapshot.packets.push(metrics);
    diagnostics.finishedAt = new Date().toISOString();
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
}
