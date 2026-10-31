import type {
  CollectedTableData,
  CollectionDataset,
  CollectionOptions,
} from "../../contracts/collection.js";
import type {
  DataEnvelope,
  ISOTime,
  ResearchScope,
} from "../../contracts/data.js";
import { marketFreshnessMs } from "../../data/market-calendar.js";
import { sessionEnd } from "../../data/market-session.js";

const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const WEEKDAYS_PER_WEEK = 5;
const SUNDAY = 0;
const SATURDAY = 6;

function globalDailyFreshnessMs(asOf: ISOTime, cutoff: ISOTime): number {
  const observationDay = Math.floor(Date.parse(asOf) / DAY_MS);
  // A UTC day becomes complete at its final millisecond, including that instant.
  const completedDay = Math.floor((Date.parse(cutoff) + 1) / DAY_MS) - 1;
  const days = Math.max(0, completedDay - observationDay);
  let weekdays = Math.floor(days / DAYS_PER_WEEK) * WEEKDAYS_PER_WEEK;
  const firstWeekday = new Date((observationDay + 1) * DAY_MS).getUTCDay();
  const remainder = days % DAYS_PER_WEEK;
  for (let offset = 0; offset < remainder; offset++) {
    const weekday = (firstWeekday + offset) % DAYS_PER_WEEK;
    if (weekday !== SUNDAY && weekday !== SATURDAY) weekdays++;
  }
  return weekdays * DAY_MS;
}

export function collectionFreshnessBudget(
  tableId: string,
  dataset: CollectionDataset,
  budgets: CollectionOptions["freshness"],
): number {
  return budgets[tableId === "valuation.history" ? "market" : dataset];
}

/** Update consumer timing while preserving source timestamps and limitations. */
export function rebaseCollectionEnvelope(
  scope: ResearchScope,
  envelope: DataEnvelope<CollectedTableData>,
  budget: number,
): void {
  envelope.cutoff = scope.cutoff;
  envelope.ageMs = Date.parse(scope.cutoff) - Date.parse(envelope.asOf);
  applyCollectionFreshness(scope, envelope, budget);
}

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
          (Date.parse(scope.cutoff) - Date.parse(envelope.asOf)) /
            (DAYS_PER_WEEK * DAY_MS),
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
  if (global) return globalDailyFreshnessMs(envelope.asOf, scope.cutoff);
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
