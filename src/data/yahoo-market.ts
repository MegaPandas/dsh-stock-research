import type { DataEnvelope, MarketData } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { MarketCapability, MarketQuery } from "../contracts/market.js";
import type { HttpClient } from "./http.js";
import { usTradingDate } from "./market-session.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  DAY_MS,
  marketCapability,
  marketEnvelope,
  OHLCV_FIELDS,
  requireMarketCoverage,
  sourceNumber,
} from "./market.js";
import {
  parseSourceJson,
  sourceArray,
  sourceError,
  sourceObject,
} from "./source.js";

export class YahooMarketAdapter {
  readonly capability: MarketCapability = {
    ...marketCapability("yahoo", "US"),
    ...SOURCE_VERSIONS["market/yahoo"],
  };

  constructor(private readonly http: HttpClient) {}

  async query(
    query: MarketQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<MarketData>> {
    requireMarketCoverage(query, this.capability);
    const symbol = query.scope.security.symbol.replaceAll(".", "-");
    const url = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.search = new URLSearchParams({
      period1: String(Date.parse(`${query.startDate}T00:00:00Z`) / 1000),
      period2: String(
        (Date.parse(`${query.scope.date}T00:00:00Z`) + DAY_MS) / 1000,
      ),
      interval: "1d",
      includeAdjustedClose: "false",
      includePrePost: "false",
    }).toString();
    const text = await this.http.getText(url, {
      ...(signal && { signal }),
      headers: { "User-Agent": "dsh-stock-research/0.1" },
    });
    const retrievedAt = new Date().toISOString();
    const chart = sourceObject(parseSourceJson(text).chart, "chart");
    if (chart.error !== null) {
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "Yahoo chart reported an error.",
        { cause: chart.error },
      );
    }
    const results = sourceArray(chart.result, "chart.result");
    if (results.length !== 1)
      sourceError("chart.result", "expected one security");
    const result = sourceObject(results[0], "chart.result[0]");
    const meta = sourceObject(result.meta, "meta");
    if (
      meta.symbol !== symbol ||
      meta.currency !== "USD" ||
      meta.exchangeTimezoneName !== "America/New_York" ||
      meta.dataGranularity !== "1d" ||
      meta.instrumentType !== "EQUITY"
    ) {
      sourceError(
        "meta",
        "security, currency, time zone, interval or instrument does not match the requested stock",
      );
    }
    const timestamps = sourceArray(result.timestamp, "timestamp");
    const quotes = sourceArray(
      sourceObject(result.indicators, "indicators").quote,
      "indicators.quote",
    );
    if (quotes.length !== 1)
      sourceError("indicators.quote", "expected one quote series");
    const quote = sourceObject(quotes[0], "quote");
    const columns = OHLCV_FIELDS.map((field) => {
      if (quote[field] === undefined) return timestamps.map(() => null);
      const column = sourceArray(quote[field], field);
      if (column.length !== timestamps.length)
        sourceError(field, "length differs from timestamps");
      return column.map((value) => sourceNumber(value, field));
    });
    const values = timestamps.map((timestamp, index) => {
      if (
        typeof timestamp !== "number" ||
        !Number.isSafeInteger(timestamp) ||
        !Number.isFinite(new Date(timestamp * 1000).getTime())
      ) {
        sourceError("timestamp", "expected valid integer Unix seconds");
      }
      return {
        date: usTradingDate(timestamp * 1000),
        open: columns[0]![index]!,
        high: columns[1]![index]!,
        low: columns[2]![index]!,
        close: columns[3]![index]!,
        volume: columns[4]![index]!,
      };
    });
    return marketEnvelope(
      values,
      query,
      this.capability,
      url.href,
      retrievedAt,
    );
  }
}
