import { isDeepStrictEqual } from "node:util";
import type {
  DataEnvelope,
  MarketData,
  ResearchScope,
} from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  QueryEnvelope,
  QueryRequest,
  QuerySnapshot,
} from "../contracts/query.js";
import { marketFreshnessMs } from "../data/market-calendar.js";
import { withPriceReturn } from "./derived-queries.js";

export function selectQuerySnapshot(
  request: QueryRequest,
  snapshots: readonly QuerySnapshot[],
): QuerySnapshot | undefined {
  const exact = snapshots.find((snapshot) =>
    isDeepStrictEqual(snapshot.request, request),
  );
  if (exact !== undefined || request.dataset !== "returns") return exact;
  const base = snapshots.find((snapshot) => {
    if (
      snapshot.request.dataset !== "market" ||
      snapshot.request.provider !== request.provider
    )
      return false;
    const market = snapshot.envelope.data as MarketData;
    return (
      snapshot.request.parameters.startDate ===
        request.parameters.historyStartDate &&
      market.bars.at(-1)!.date <= request.parameters.endDate &&
      request.parameters.endDate <= snapshot.scope.date
    );
  });
  if (base === undefined) return undefined;
  const market = base.envelope.data as MarketData;
  const envelope: DataEnvelope<MarketData> = {
    ...base.envelope,
    dataset: "market",
    data: {
      currency: market.currency,
      adjustment: market.adjustment,
      bars: market.bars,
    },
  };
  return {
    scope: base.scope,
    request,
    envelope: withPriceReturn(envelope, request.parameters),
  };
}

/** Adopt the captured values; only scope-derived age/freshness changes. */
export function adoptQuerySnapshot(
  scope: ResearchScope,
  request: QueryRequest,
  snapshot: QuerySnapshot,
): QueryEnvelope {
  if (
    !isDeepStrictEqual(scope.security, snapshot.scope.security) ||
    scope.date !== snapshot.scope.date ||
    snapshot.scope.cutoff > scope.cutoff ||
    snapshot.envelope.cutoff !== snapshot.scope.cutoff ||
    !isDeepStrictEqual(request, snapshot.request) ||
    snapshot.envelope.dataset !== request.dataset ||
    snapshot.envelope.source.provider !== request.provider
  )
    throw new ResearchError(
      "INVALID_INPUT",
      "The fixed query does not match this research scope and request.",
    );
  const envelope = structuredClone(snapshot.envelope);
  envelope.cutoff = scope.cutoff;
  envelope.ageMs = Date.parse(scope.cutoff) - Date.parse(envelope.asOf);
  const freshnessMs =
    request.dataset === "market" || request.dataset === "returns"
      ? marketFreshnessMs(scope.security, envelope.asOf, scope.cutoff)
      : envelope.ageMs;
  if (
    "maxAgeMs" in request.parameters &&
    freshnessMs > request.parameters.maxAgeMs
  ) {
    envelope.stale = true;
    if (!envelope.gaps.some((gap) => gap.code === "stale"))
      envelope.gaps.push({
        code: "stale",
        field: "/asOf",
        detail: `The captured observation exceeds its dataset freshness budget (${freshnessMs} ms); policy allows ${request.parameters.maxAgeMs} ms.`,
      });
  }
  return envelope;
}
