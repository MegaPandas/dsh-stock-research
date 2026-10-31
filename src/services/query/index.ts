import type { SqliteCache } from "../../cache/index.js";
import type { ResearchScope } from "../../contracts/data.js";
import { ResearchError } from "../../contracts/errors.js";
import type {
  QueryCachePolicy,
  QueryEnvelope,
  QueryRequest,
  QueryResponse,
  MarketSourceQuery,
  SourceResponse,
} from "../../contracts/query.js";
import type { QueryHealth, QuerySources } from "../../contracts/sources.js";
import { serializeJson } from "../../json/serialize.js";
import { withIndicators, withPriceReturn } from "./calculations.js";
import { SourceQueries } from "./source-queries.js";

/** Captures ordinary queries and composes derived results from raw source data. */
export class QueryService {
  readonly #sources: SourceQueries;

  constructor(
    sources: Readonly<QuerySources>,
    cache: Pick<SqliteCache, "get" | "set">,
    cachePolicy: QueryCachePolicy,
  ) {
    this.#sources = new SourceQueries(sources, cache, cachePolicy);
  }

  async query<Q extends QueryRequest>(
    scope: ResearchScope,
    request: Q,
    signal?: AbortSignal,
  ): Promise<QueryResponse<Q>> {
    const active = signal
      ? AbortSignal.any([this.#sources.signal, signal])
      : this.#sources.signal;
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
    return this.#sources.health(scope);
  }

  close(): Promise<void> {
    return this.#sources.close();
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
      const market = await this.#sources.query(
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
      const market = await this.#sources.query(
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
    return this.#sources.query(scope, request, signal);
  }
}
