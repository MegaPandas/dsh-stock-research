import type {
  CollectedTableData,
  CollectionAttempt,
  CollectionFailure,
  CollectionTask,
} from "../contracts/collection.js";
import type { DataEnvelope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { getHttpRequestMetadata, HttpStatusError } from "../data/http.js";
import { collectionError, collectionErrorDetail } from "./collection-errors.js";

const ENDPOINT_FAILURE_THRESHOLD = 2;
const ENDPOINT_DEPRIORITIZE_MS = 60_000;

type SourceOutcome =
  | { kind: "success"; envelope: DataEnvelope<CollectedTableData> }
  | { kind: "failed"; failure: CollectionFailure }
  | { kind: "deferred" };

interface SourceExecution {
  signal: AbortSignal;
  timeoutMs: number;
  attempt: number;
  alternatives: readonly CollectionTask[];
  onStart(): void;
  onAttempt(attempt: CollectionAttempt): void;
}

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

function retryable(cause: unknown): boolean {
  return cause instanceof HttpStatusError
    ? cause.status === 429 || cause.status >= 500
    : cause instanceof Error &&
        (cause.name === "TimeoutError" ||
          (cause instanceof TypeError && cause.message === "fetch failed"));
}

function endpointKey(task: CollectionTask): string {
  return `${task.provider}:${task.endpoint ?? task.id}`;
}

async function waitForSource(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
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

/** One queue per provider, shared across tables and simultaneous collections. */
export class CollectionSourceRunner {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #endpoints = new Map<
    string,
    { failures: number; retryAt: number }
  >();

  priority(task: CollectionTask): number {
    return (this.#endpoints.get(endpointKey(task))?.retryAt ?? 0) > Date.now()
      ? 1
      : 0;
  }

  async run(
    task: CollectionTask,
    execution: SourceExecution,
  ): Promise<SourceOutcome> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          new DOMException(
            `Collection source ${task.provider} exceeded its attempt budget.`,
            "TimeoutError",
          ),
        ),
      execution.timeoutMs,
    );
    const signal = AbortSignal.any([execution.signal, timeout.signal]);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let started = false;
    try {
      let outcome: SourceOutcome;
      try {
        outcome = await this.serial(task.provider, signal, async () => {
          signal.throwIfAborted();
          if (
            execution.alternatives.some(
              (other) => this.priority(task) > this.priority(other),
            )
          )
            return { kind: "deferred" };
          started = true;
          execution.onStart();
          const envelope = await task.run(signal);
          signal.throwIfAborted();
          return { kind: "success", envelope };
        });
      } catch (cause) {
        const failure = signal.aborted ? signal.reason : cause;
        const error = collectionError(failure);
        const endpoint = getHttpRequestMetadata(cause)?.url ?? task.endpoint;
        const durationMs = Math.round(performance.now() - start);
        execution.onAttempt({
          id: task.id,
          provider: task.provider,
          attempt: execution.attempt,
          startedAt,
          durationMs,
          outcome: execution.signal.aborted ? "cancelled" : "failed",
          error,
          ...(endpoint === undefined ? {} : { endpoint }),
        });
        execution.signal.throwIfAborted();
        if (!recoverable(failure)) throw failure;
        // Queue congestion is local; it must not mark the remote endpoint unhealthy.
        if (
          started &&
          (!(failure instanceof ResearchError) ||
            failure.code === "SOURCE_UNAVAILABLE")
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
        return {
          kind: "failed",
          failure: {
            id: task.id,
            provider: task.provider,
            code:
              failure instanceof ResearchError ? failure.code : failure.name,
            retryable: retryable(failure),
            detail: collectionErrorDetail(error),
            error,
            attempt: execution.attempt,
            durationMs,
            ...(endpoint === undefined ? {} : { endpoint }),
          },
        };
      }
      if (outcome.kind === "success") {
        execution.onAttempt({
          id: task.id,
          provider: task.provider,
          attempt: execution.attempt,
          startedAt,
          durationMs: Math.round(performance.now() - start),
          outcome: "success",
          endpoint:
            task.endpoint ?? outcome.envelope.source.url.split(/[?#]/, 1)[0]!,
        });
        this.#endpoints.delete(endpointKey(task));
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  private async serial<T>(
    provider: string,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(provider, tail);
    void tail.then(() => {
      if (this.#tails.get(provider) === tail) this.#tails.delete(provider);
    });
    try {
      await waitForSource(previous, signal);
      signal.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }
}
