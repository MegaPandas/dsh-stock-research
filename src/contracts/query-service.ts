import type { ResearchScope } from "./data.js";
import type { QueryRequest, QueryResponse } from "./query.js";
import type { QueryHealth } from "./sources.js";

export interface QueryAccess {
  query<Q extends QueryRequest>(
    scope: ResearchScope,
    request: Q,
    signal?: AbortSignal,
  ): Promise<QueryResponse<Q>>;
  health(scope: ResearchScope): QueryHealth;
}
