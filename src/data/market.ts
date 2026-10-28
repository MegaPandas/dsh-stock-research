import type {
  DataEnvelope,
  DataGap,
  ISOTime,
  MarketBar,
  MarketData,
} from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { MarketCapability, MarketQuery } from "../contracts/market.js";
import { sessionEnd, SESSION_DATES } from "./market-session.js";
import { marketFreshnessMs } from "./market-calendar.js";
import { sourceError } from "./source.js";
import { DAILY_BAR_VERSIONS } from "./versions.js";

export const OHLCV_FIELDS = ["open", "high", "low", "close", "volume"] as const;
export const SHARES_PER_LOT = 100;
export const DAY_MS = 86_400_000;
export type DailyValues = Pick<
  MarketBar,
  "date" | (typeof OHLCV_FIELDS)[number]
>;

export function marketCapability(
  provider: string,
  market: "US" | "CN",
): MarketCapability {
  return {
    provider,
    dataset: "market",
    market,
    exchanges: market === "US" ? ["NASDAQ", "NYSE"] : ["SH", "SZ"],
    fields: OHLCV_FIELDS,
    interval: "1d",
    currency: market === "US" ? "USD" : "CNY",
    adjustment: market === "US" ? "split_adjusted" : "unadjusted",
    dates: SESSION_DATES,
    historicalVersions: false,
    ...DAILY_BAR_VERSIONS,
  };
}

export function requireMarketCoverage(
  query: MarketQuery,
  capability: MarketCapability,
): void {
  const { security, date } = query.scope;
  if (
    security.market !== capability.market ||
    !capability.exchanges.includes(security.exchange) ||
    query.startDate < capability.dates.start ||
    date > capability.dates.end
  ) {
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `${capability.provider} supports ${capability.exchanges.join("/")} daily bars within ${capability.dates.start}–${capability.dates.end}.`,
    );
  }
}

export function sourceNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    sourceError(field, "expected a nonnegative finite number or null");
  }
  return value;
}

export function sourceDecimal(
  value: unknown,
  field: string,
  scale = 1,
): number | null {
  if (value === null || value === "" || value === "-") return null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    sourceError(field, "expected a decimal string or a missing-value marker");
  }
  return sourceNumber(Number(value) * scale, field);
}

export function marketEnvelope(
  values: DailyValues[],
  query: MarketQuery,
  capability: MarketCapability,
  url: string,
  retrievedAt: ISOTime,
): DataEnvelope<MarketData> {
  const cutoffMs = Date.parse(query.scope.cutoff);
  const observedBy = Math.min(cutoffMs, Date.parse(retrievedAt));
  const bars: MarketBar[] = values
    .filter(({ date }) => date >= query.startDate && date <= query.scope.date)
    .map((row) => ({
      ...row,
      asOf: sessionEnd(row.date, query.scope.security),
      availableAt: null,
      sessionComplete: true,
    }))
    .filter((bar) => Date.parse(bar.asOf) <= observedBy)
    .sort((left, right) => left.date.localeCompare(right.date));
  const last = bars.at(-1);
  if (last === undefined)
    throw new ResearchError(
      "DATA_INSUFFICIENT",
      "No completed daily bars within the requested range and cutoff.",
    );

  const gaps: DataGap[] = [
    {
      code: "unverified_time",
      field: "/data/bars",
      detail:
        "The source supplies its current historical view, without a publication timestamp or point-in-time version for each bar. Session end does not prove publication or final source refresh.",
    },
  ];
  for (const [index, bar] of bars.entries()) {
    if (index > 0 && bars[index - 1]!.date === bar.date)
      sourceError(bar.date, "duplicate daily bar");
    for (const field of OHLCV_FIELDS) {
      if (bar[field] === null)
        gaps.push({
          code: "missing",
          field: `/data/bars/${index}/${field}`,
          detail: `${field} is absent for ${bar.date}.`,
        });
    }
    const { open, high, low, close } = bar;
    if (
      (high !== null && low !== null && high < low) ||
      (high !== null &&
        ((open !== null && open > high) || (close !== null && close > high))) ||
      (low !== null &&
        ((open !== null && open < low) || (close !== null && close < low)))
    ) {
      sourceError(
        bar.date,
        "OHLC values contradict the declared high/low range",
      );
    }
  }
  const ageMs = cutoffMs - Date.parse(last.asOf);
  const freshnessMs = marketFreshnessMs(
    query.scope.security,
    last.asOf,
    query.scope.cutoff,
  );
  const stale = freshnessMs > query.maxAgeMs;
  if (stale)
    gaps.push({
      code: "stale",
      field: "/data/bars",
      detail: `Trading-date age is ${freshnessMs} ms (24h per completed trading date); policy allows ${query.maxAgeMs} ms.`,
    });
  return {
    dataset: "market",
    data: {
      currency: capability.currency,
      adjustment: capability.adjustment,
      bars,
    },
    source: {
      provider: capability.provider,
      url,
      adapterVersion: capability.adapterVersion,
      normalizationVersion: capability.normalizationVersion,
    },
    asOf: last.asOf,
    availableAt: null,
    retrievedAt,
    cutoff: query.scope.cutoff,
    ageMs,
    stale,
    historicalKnowledge: "unverified",
    gaps,
  };
}
