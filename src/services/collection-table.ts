import { setTimeout as delay } from "node:timers/promises";
import type {
  CollectedTableData,
  CollectionDiagnostics,
  CollectionFailure,
  CollectionPlan,
  CollectionProgress,
  CollectionTask,
} from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import { CollectionCache } from "./collection-cache.js";
import { CollectionSourceRunner } from "./collection-source.js";
import {
  collectionCoverageIssue,
  improvesCollectionCoverage,
} from "./collection-quality.js";
import { collectionError, collectionErrorDetail } from "./collection-errors.js";

const MAX_ROUNDS = 2;
const RETRY_DELAY_MS = 2_000;

type TableResult = (
  | {
      status: "complete" | "partial";
      envelope: DataEnvelope<CollectedTableData>;
    }
  | { status: "unavailable" }
) & { failures: CollectionFailure[] };

interface TableExecution {
  signal: AbortSignal;
  diagnostics: CollectionDiagnostics;
  failures: CollectionFailure[];
  notify(progress: Pick<CollectionProgress, "current" | "failures">): void;
}

/** Execute one table plan; all source and cache results use the same selection rules. */
export class CollectionTableRunner {
  constructor(
    private readonly cache: CollectionCache,
    private readonly sources: CollectionSourceRunner,
  ) {}

  async collect(
    plan: CollectionPlan,
    scope: ResearchScope,
    execution: TableExecution,
  ): Promise<TableResult> {
    const failures: CollectionFailure[] = [];
    let reportedFailures = 0;
    let selected: DataEnvelope<CollectedTableData> | undefined;
    let partial: DataEnvelope<CollectedTableData> | undefined;
    let lastSource = plan.candidates[0]!;
    const deadline = new AbortController();
    const expiresAt = performance.now() + plan.timeoutMs;
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            `Collection of ${plan.id} exceeded its ${plan.timeoutMs / 1000}-second budget.`,
            "TimeoutError",
          ),
        ),
      plan.timeoutMs,
    );
    const signal = AbortSignal.any([execution.signal, deadline.signal]);

    const accept = (
      candidate: CollectionTask,
      envelope: DataEnvelope<CollectedTableData>,
    ) => {
      const issue = collectionCoverageIssue(envelope);
      if (issue === undefined) {
        selected = envelope;
      } else {
        if (
          envelope.data.rows.length > 0 &&
          (partial === undefined ||
            improvesCollectionCoverage(partial, envelope))
        )
          partial = envelope;
        failures.push({
          id: plan.id,
          provider: candidate.provider,
          code: "DATA_INSUFFICIENT",
          detail: issue,
        });
      }
    };
    const load = async (
      candidate: CollectionTask,
      alternatives: readonly CollectionTask[],
      attempt: number,
    ) => {
      lastSource = candidate;
      const outcome = await this.sources.run(candidate, {
        signal,
        attempt,
        alternatives,
        timeoutMs: Math.max(
          1,
          (expiresAt - performance.now()) / (alternatives.length + 1),
        ),
        onStart: () =>
          execution.notify({
            current: { id: plan.id, provider: candidate.provider },
          }),
        onAttempt: (value) => execution.diagnostics.attempts.push(value),
      });
      if (outcome.kind === "failed") failures.push(outcome.failure);
      else if (outcome.kind === "success") {
        // Cache failures are local integrity errors, outside the source-failure boundary.
        this.cache.write(scope, candidate, outcome.envelope);
        this.cache.refresh(scope, candidate, outcome.envelope);
        accept(candidate, outcome.envelope);
      }
      return outcome.kind;
    };

    try {
      let candidates = [...plan.candidates];
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        signal.throwIfAborted();
        const uncached: CollectionTask[] = [];
        for (const candidate of candidates) {
          const cached = this.cache.read(scope, candidate);
          if (cached === undefined) {
            execution.diagnostics.cacheMisses++;
            uncached.push(candidate);
          } else {
            execution.diagnostics.cacheHits++;
            accept(candidate, cached);
            if (selected !== undefined) break;
          }
        }
        if (selected !== undefined) break;
        uncached.sort(
          (left, right) =>
            this.sources.priority(left) - this.sources.priority(right),
        );
        const deferred: CollectionTask[] = [];
        for (const [index, candidate] of uncached.entries()) {
          const outcome = await load(
            candidate,
            uncached.slice(index + 1),
            round,
          );
          if (outcome === "deferred") deferred.push(candidate);
          if (selected !== undefined) break;
        }
        if (selected === undefined) {
          // Revisit sources demoted while queueing; deferred sources are not skipped.
          for (const candidate of deferred) {
            await load(candidate, [], round);
            if (selected !== undefined) break;
          }
        }
        if (
          selected !== undefined ||
          partial !== undefined ||
          round === MAX_ROUNDS
        )
          break;
        candidates = candidates.filter((candidate) =>
          failures.some(
            (failure) =>
              failure.provider === candidate.provider && failure.retryable,
          ),
        );
        if (candidates.length === 0) break;
        execution.notify({ failures: failures.slice() });
        reportedFailures = failures.length;
        await delay(RETRY_DELAY_MS, undefined, { signal });
      }
    } catch (cause) {
      if (!deadline.signal.aborted || execution.signal.aborted) throw cause;
      const error = collectionError(deadline.signal.reason);
      failures.push({
        id: plan.id,
        provider: lastSource.provider,
        code: "TimeoutError",
        detail: collectionErrorDetail(error),
        error,
        ...(lastSource.endpoint === undefined
          ? {}
          : { endpoint: lastSource.endpoint }),
      });
    } finally {
      clearTimeout(timer);
      execution.failures.push(...failures);
    }
    const unreported = failures.slice(reportedFailures);
    if (selected !== undefined)
      return { status: "complete", envelope: selected, failures: unreported };
    if (partial !== undefined)
      return { status: "partial", envelope: partial, failures: unreported };
    return { status: "unavailable", failures: unreported };
  }
}
