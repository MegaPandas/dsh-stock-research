import { createCacheKey, type SqliteCache } from "../cache/index.js";
import { serializeJson } from "../cache/json.js";
import type { QueryCacheKey } from "../contracts/cache.js";
import type { ISOTime, ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  QueryCachePolicy,
  QueryEnvelope,
  QueryRequest,
  QueryResponse,
  MarketSourceQuery,
  SourceData,
  SourceEnvelope,
  SourceQuery,
  SourceResponse,
} from "../contracts/query.js";
import { withIndicators, withPriceReturn } from "./derived-queries.js";
import {
  describeSources,
  selectSource,
  type QuerySources,
  type SourceDescription,
  type SourceSelection,
} from "./query-sources.js";
import { SharedQueries } from "./shared-queries.js";

interface SourceObservation {
  cacheHits: number;
  sourceCalls: number;
  lastQuery: {
    at: ISOTime;
    outcome: "succeeded" | "failed" | "cancelled";
    errorCode: string | null;
  } | null;
}
export interface SourceHealth extends SourceDescription, SourceObservation {}
export interface QueryHealth {
  scope: ResearchScope;
  sources: SourceHealth[];
}

function sourceKey(request: Pick<SourceQuery, "dataset" | "provider">): string {
  return `${request.dataset}/${request.provider}`;
}
function combined(lifetime: AbortSignal, signal?: AbortSignal): AbortSignal {
  return signal === undefined ? lifetime : AbortSignal.any([lifetime, signal]);
}
function errorCode(cause: unknown): string {
  return cause instanceof ResearchError
    ? cause.code
    : cause instanceof Error
      ? cause.name
      : "UnknownError";
}

export class QueryService {
  readonly #sourceFlights = new SharedQueries<SourceEnvelope>();
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

  async query<Q extends QueryRequest>(
    scope: ResearchScope,
    request: Q,
    signal?: AbortSignal,
  ): Promise<QueryResponse<Q>> {
    const active = combined(this.#sourceFlights.signal, signal);
    active.throwIfAborted();
    const captured = JSON.parse(serializeJson({ scope, request })) as {
      scope: ResearchScope;
      request: Q;
    };
    return (await this.resolve(
      captured.scope,
      captured.request,
      active,
    )) as QueryResponse<Q>;
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
    return this.#sourceFlights.close();
  }

  private async resolve(
    scope: ResearchScope,
    request: QueryRequest,
    signal: AbortSignal,
  ): Promise<QueryEnvelope> {
    if (request.dataset === "returns") {
      const { historyStartDate, startDate, endDate, maxAgeMs } =
        request.parameters;
      if (
        historyStartDate > startDate ||
        startDate > endDate ||
        endDate > scope.date
      )
        throw new ResearchError(
          "INVALID_INPUT",
          "Return history, requested dates and research date must be ordered.",
        );
      const market = await this.load(
        { ...scope, date: endDate },
        {
          dataset: "market",
          provider: request.provider,
          parameters: { startDate: historyStartDate, maxAgeMs },
        },
        signal,
      );
      signal.throwIfAborted();
      return withPriceReturn(
        market as SourceResponse<MarketSourceQuery>,
        request.parameters,
      );
    }
    if (request.dataset === "market" && "indicators" in request.parameters) {
      const { startDate, maxAgeMs, indicators } = request.parameters;
      const market = await this.load(
        scope,
        {
          dataset: "market",
          provider: request.provider,
          parameters: { startDate, maxAgeMs },
        },
        signal,
      );
      signal.throwIfAborted();
      return withIndicators(
        market as SourceResponse<MarketSourceQuery>,
        indicators,
      );
    }
    return this.load(scope, request, signal);
  }

  private async load(
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
    const envelope = await this.#sourceFlights.run(
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
    // Each consumer receives its own JSON snapshot, including ordinary/task co-consumers.
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
