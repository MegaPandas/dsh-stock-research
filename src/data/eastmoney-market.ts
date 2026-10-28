import type { DataEnvelope, MarketData } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { MarketCapability, MarketQuery } from "../contracts/market.js";
import type { HttpClient } from "./http.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  DAY_MS,
  marketCapability,
  marketEnvelope,
  requireMarketCoverage,
  SHARES_PER_LOT,
  sourceDecimal,
} from "./market.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

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
    const code = query.scope.security.symbol.slice(0, 6);
    const market = query.scope.security.exchange === "SH" ? 1 : 0;
    const url = new URL(
      "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    );
    url.search = new URLSearchParams({
      secid: `${market}.${code}`,
      klt: "101",
      fqt: "0",
      beg: query.startDate.replaceAll("-", ""),
      end: query.scope.date.replaceAll("-", ""),
      fields1: "f1,f2",
      fields2: "f51,f52,f53,f54,f55,f56",
      lmt: String(
        (Date.parse(query.scope.date) - Date.parse(query.startDate)) / DAY_MS +
          1,
      ),
    }).toString();
    const text = await this.http.getText(url, {
      ...(signal && { signal }),
      headers: { Referer: "https://quote.eastmoney.com/" },
    });
    const retrievedAt = new Date().toISOString();
    const response = parseSourceJson(text);
    if (response.rc !== 0)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "Eastmoney reported an error.",
        { cause: response },
      );
    if (response.data === null)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "Eastmoney returned no stock data.",
      );
    const data = sourceObject(response.data, "data");
    if (data.code !== code || data.market !== market)
      sourceError("data", "security does not match the request");
    const values = sourceArray(data.klines, "klines").map((line) => {
      if (typeof line !== "string") sourceError("klines", "expected a CSV row");
      const fields = line.split(",");
      if (fields.length < 6)
        sourceError("klines", "expected date and five OHLCV columns");
      return {
        date: sourceDate(fields[0]),
        open: sourceDecimal(fields[1], "open"),
        close: sourceDecimal(fields[2], "close"),
        high: sourceDecimal(fields[3], "high"),
        low: sourceDecimal(fields[4], "low"),
        volume: sourceDecimal(fields[5], "volume", SHARES_PER_LOT),
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
