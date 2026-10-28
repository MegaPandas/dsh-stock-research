import type { CollectedTableData } from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import { marketFreshnessMs } from "../data/market-calendar.js";
import { sessionEnd } from "../data/market-session.js";

const DAY_MS = 86_400_000;

/** Market budgets count completed bars: one lagged daily/weekly/monthly bar costs one day unit. */
export function collectionFreshnessMs(
  scope: ResearchScope,
  envelope: DataEnvelope<CollectedTableData>,
): number {
  const data = envelope.data;
  const global = data.attributes?.calendar === "global_weekdays_utc";
  if (envelope.dataset !== "market" && data.table !== "valuation.history")
    return envelope.ageMs;
  if (data.interval === "1wk")
    return (
      Math.max(
        0,
        Math.floor(
          (Date.parse(scope.cutoff) - Date.parse(envelope.asOf)) / (7 * DAY_MS),
        ),
      ) * DAY_MS
    );
  if (data.interval === "1mo") {
    const current = new Date(global ? scope.cutoff : `${scope.date}T00:00:00Z`);
    const monthEnd = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);
    const monthCompletedAt = global
      ? `${monthEnd}T23:59:59.999Z`
      : sessionEnd(monthEnd, scope.security);
    const completedMonth =
      current.getUTCFullYear() * 12 +
      current.getUTCMonth() -
      (monthCompletedAt > scope.cutoff ? 1 : 0);
    const observed = new Date(envelope.asOf);
    return (
      Math.max(
        0,
        completedMonth -
          (observed.getUTCFullYear() * 12 + observed.getUTCMonth()),
      ) * DAY_MS
    );
  }
  if (global) {
    let lag = 0;
    const end = scope.cutoff.slice(0, 10);
    for (
      let date = new Date(`${envelope.asOf.slice(0, 10)}T00:00:00.000Z`);
      ;
    ) {
      date = new Date(date.getTime() + DAY_MS);
      const day = date.toISOString().slice(0, 10);
      if (day > end) break;
      if (
        date.getUTCDay() !== 0 &&
        date.getUTCDay() !== 6 &&
        `${day}T23:59:59.999Z` <= scope.cutoff
      )
        lag++;
    }
    return lag * DAY_MS;
  }
  return marketFreshnessMs(scope.security, envelope.asOf, scope.cutoff);
}

export function applyCollectionFreshness(
  scope: ResearchScope,
  envelope: DataEnvelope<CollectedTableData>,
  budget: number,
): void {
  const age = collectionFreshnessMs(scope, envelope);
  if (age > budget) {
    envelope.stale = true;
    if (!envelope.gaps.some((gap) => gap.code === "stale"))
      envelope.gaps.push({
        code: "stale",
        field: "/data/rows",
        detail: `The observation exceeds the configured freshness budget: ${age} ms against ${budget} ms. Market age counts completed bars at the table's interval, one day unit per lagged bar.`,
      });
  }
}
