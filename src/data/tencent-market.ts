import type { DataEnvelope, MarketData } from "../contracts/data.js";
import type { MarketQuery } from "../contracts/market.js";
import type { HttpClient } from "./http.js";
import {
  DAY_MS,
  marketCapability,
  marketEnvelope,
  requireMarketCoverage,
  SHARES_PER_LOT,
} from "./market.js";
import { tencentKlines } from "./tencent-kline.js";

export class TencentMarketAdapter {
  readonly capability = marketCapability("tencent", "CN");

  constructor(private readonly http: HttpClient) {}

  async query(
    query: MarketQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<MarketData>> {
    requireMarketCoverage(query, this.capability);
    const symbol =
      query.scope.security.exchange.toLowerCase() +
      query.scope.security.symbol.slice(0, 6);
    const volumeScale =
      symbol.startsWith("sh688") || symbol.startsWith("sh689")
        ? 1
        : SHARES_PER_LOT;
    // One daily row at most per calendar day; asking for fewer truncates the front.
    const count =
      (Date.parse(query.scope.date) - Date.parse(query.startDate)) / DAY_MS + 1;
    const response = await tencentKlines(
      this.http,
      {
        symbol,
        period: "day",
        start: query.startDate,
        end: query.scope.date,
        count,
        volumeScale,
      },
      signal,
    );
    return marketEnvelope(
      response.rows,
      query,
      this.capability,
      response.url,
      response.retrievedAt,
    );
  }
}
