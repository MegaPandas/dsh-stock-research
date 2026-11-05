import type { DataEnvelope, MarketData } from "../contracts/data.js";
import type { MarketCapability, MarketQuery } from "../contracts/market.js";
import type { HttpClient } from "./http.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  DAY_MS,
  marketCapability,
  marketEnvelope,
  requireMarketCoverage,
} from "./market.js";
import { eastmoneyStockKlines } from "./eastmoney-kline.js";

export class EastmoneyMarketAdapter {
  readonly capability: MarketCapability = {
    ...marketCapability("eastmoney", "CN"),
    ...SOURCE_VERSIONS["market/eastmoney"],
  };

  constructor(private readonly http: HttpClient) {}

  async query(
    query: MarketQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<MarketData>> {
    requireMarketCoverage(query, this.capability);
    const response = await eastmoneyStockKlines(
      this.http,
      {
        security: query.scope.security,
        interval: "1d",
        start: query.startDate,
        end: query.scope.date,
        count:
          (Date.parse(query.scope.date) - Date.parse(query.startDate)) /
            DAY_MS +
          1,
        fields: "ohlcv",
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
