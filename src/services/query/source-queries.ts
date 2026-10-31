import { createCacheKey, type SqliteCache } from "../../cache/index.js";
import type { QueryCacheKey, QueryCachePolicy } from "../../contracts/cache.js";
import type { ResearchScope } from "../../contracts/data.js";
import { ResearchError } from "../../contracts/errors.js";
import type {
  SourceData,
  SourceEnvelope,
  SourceQuery,
} from "../../contracts/query.js";
import type {
  QueryHealth,
  QuerySources,
  SourceHealth,
} from "../../contracts/sources.js";
import { SharedQueries } from "../shared-queries.js";
import {
  describeSources,
  selectSource,
  type SourceSelection,
} from "./source-selection.js";

type SourceObservation = Pick<
  SourceHealth,
  "cacheHits" | "sourceCalls" | "lastQuery"
>;

function sourceKey(request: Pick<SourceQuery, "dataset" | "provider">): string {
  return `${request.dataset}/${request.provider}`;
}
function errorCode(cause: unknown): string {
  return cause instanceof ResearchError
    ? cause.code
    : cause instanceof Error
      ? cause.name
      : "UnknownError";
}

/** Owns raw source requests, their shared execution and observed cache activity. */
export class SourceQueries {
  readonly #flights = new SharedQueries<SourceEnvelope>();
  readonly #observations = new Map<string, SourceObservation>();

  constructor(
    private readonly sources: Readonly<QuerySources>,
    private readonly cache: Pick<SqliteCache, "get" | "set">,
    private readonly cachePolicy: QueryCachePolicy,
  ) {
    for (const ttl of Object.values(cachePolicy))
      if (!Number.isFinite(ttl) || ttl < 0)
        throw new ResearchError(
          "INVALID_INPUT",
          "Query cache TTL must be a finite nonnegative duration.",
        );
    for (const source of describeSources(sources))
      this.#observations.set(sourceKey(source), {
        cacheHits: 0,
        sourceCalls: 0,
        lastQuery: null,
      });
  }

  get signal(): AbortSignal {
    return this.#flights.signal;
  }

  health(scope: ResearchScope): QueryHealth {
    return structuredClone({
      scope,
      sources: describeSources(this.sources).map((source) => ({
        ...source,
        ...this.#observations.get(sourceKey(source))!,
      })),
    });
  }

  close(): Promise<void> {
    return this.#flights.close();
  }

  async query(
    scope: ResearchScope,
    request: SourceQuery,
    signal: AbortSignal,
  ): Promise<SourceEnvelope> {
    signal.throwIfAborted();
    const selected = selectSource(this.sources, scope, request);
    const observation = this.#observations.get(sourceKey(request))!;
    const key: QueryCacheKey = {
      provider: request.provider,
      securityId: scope.security.id,
      dataset: request.dataset,
      cutoff: scope.cutoff,
      parameters: {
        date: scope.date,
        security: { ...scope.security },
        query: { ...request.parameters },
      },
      adapterVersion: selected.capability.adapterVersion,
      normalizationVersion: selected.capability.normalizationVersion,
    };
    const cached = this.cache.get<SourceData>(key);
    if (cached !== undefined) {
      observation.cacheHits++;
      return cached;
    }
    const identity = createCacheKey(key);
    const envelope = await this.#flights.run(
      identity,
      identity,
      (producerSignal) =>
        this.fetch(
          selected,
          key,
          this.cachePolicy[request.dataset],
          observation,
          producerSignal,
        ),
      signal,
    );
    // Each consumer receives its own snapshot, including ordinary/task co-consumers.
    return structuredClone(envelope);
  }

  private async fetch(
    selected: SourceSelection,
    key: QueryCacheKey,
    ttlMs: number,
    observation: SourceObservation,
    signal: AbortSignal,
  ): Promise<SourceEnvelope> {
    signal.throwIfAborted();
    observation.sourceCalls++;
    let envelope: SourceEnvelope;
    try {
      envelope = await selected.fetch(signal);
      signal.throwIfAborted();
    } catch (cause) {
      const error: unknown = signal.aborted ? signal.reason : cause;
      observation.lastQuery = {
        at: new Date().toISOString(),
        outcome: signal.aborted ? "cancelled" : "failed",
        errorCode: errorCode(error),
      };
      throw error;
    }
    observation.lastQuery = {
      at: new Date().toISOString(),
      outcome: "succeeded",
      errorCode: null,
    };
    this.cache.set(key, envelope, ttlMs);
    return envelope;
  }
}
