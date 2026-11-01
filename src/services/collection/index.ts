import { deriveFinancialMetrics } from "../../data/financial-metrics.js";
import type { SqliteCache } from "../../cache/index.js";
import { serializeJson } from "../../json/serialize.js";
import type {
  CollectionAccess,
  CollectionDiagnostics,
  CollectionOptions,
  CollectionPlan,
  CollectionProgress,
  CollectionSnapshot,
  CollectionRecord,
  CollectionDataset,
  CollectionTaskFactory,
} from "../../contracts/collection.js";
import type { ResearchScope } from "../../contracts/data.js";
import type { CollectionSnapshotStore } from "../../storage/collection-snapshots.js";
import { collectionError } from "./errors.js";
import { createCollectionPlans } from "./plan.js";
import { CollectionCache } from "./cache.js";
import { CollectionSourceRunner } from "./source.js";
import { CollectionTableRunner } from "./table.js";
import { SharedQueries } from "../shared-queries.js";
import {
  collectionFreshnessBudget,
  rebaseCollectionEnvelope,
} from "./freshness.js";

interface ProgressObservers {
  waiters: number;
  listeners: Set<(progress: CollectionProgress) => void>;
  latest?: CollectionProgress;
}

/** Own a collection's lifecycle, progress and durable snapshot. */
export class CollectionService implements CollectionAccess {
  readonly #flights = new SharedQueries<CollectionSnapshot>();
  readonly #options: CollectionOptions;
  readonly #progress = new Map<string, ProgressObservers>();
  readonly #tables: CollectionTableRunner;

  constructor(
    private readonly createTasks: CollectionTaskFactory,
    cache: Pick<SqliteCache, "get" | "set">,
    options: CollectionOptions,
    private readonly snapshots?: Pick<CollectionSnapshotStore, "save">,
  ) {
    this.#options = structuredClone(options);
    this.#tables = new CollectionTableRunner(
      new CollectionCache(cache, this.#options),
      new CollectionSourceRunner(),
      this.#options.freshness,
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
      rebaseCollectionEnvelope(
        scope,
        packet.envelope,
        collectionFreshnessBudget(
          packet.id,
          packet.envelope.dataset as CollectionDataset,
          this.#options.freshness,
        ),
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
      this.createTasks(scope, this.#options),
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
