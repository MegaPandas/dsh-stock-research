import type { Security } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { collectedNumber } from "./collection-utils.js";
import type { HttpClient } from "./http.js";
import { type DailyValues, SHARES_PER_LOT, sourceDecimal } from "./market.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

export const EASTMONEY_KLINE_ENDPOINT =
  "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const PERIODS = { "1d": "101", "1wk": "102", "1mo": "103" } as const;

interface KlineRequest {
  security: Pick<Security, "symbol" | "exchange">;
  interval: keyof typeof PERIODS;
  start: string;
  end: string;
  count: number;
}
interface StockStatistics extends DailyValues {
  amount: number | null;
  amplitude: number | null;
  changePercent: number | null;
  change: number | null;
  turnover: number | null;
}
interface KlineResponse<Row> {
  rows: Row[];
  url: string;
  retrievedAt: string;
}

export function eastmoneyStockKlines(
  http: HttpClient,
  request: KlineRequest & { fields: "ohlcv" },
  signal?: AbortSignal,
): Promise<KlineResponse<DailyValues>>;
export function eastmoneyStockKlines(
  http: HttpClient,
  request: KlineRequest & { fields: "statistics" },
  signal?: AbortSignal,
): Promise<KlineResponse<StockStatistics>>;
/** Source-native unadjusted stock periods; volume is normalized from lots to shares. */
export async function eastmoneyStockKlines(
  http: HttpClient,
  request: KlineRequest & { fields: "ohlcv" | "statistics" },
  signal?: AbortSignal,
): Promise<KlineResponse<DailyValues | StockStatistics>> {
  const code = request.security.symbol.slice(0, 6);
  const market = request.security.exchange === "SH" ? 1 : 0;
  const statistics = request.fields === "statistics";
  const url = new URL(EASTMONEY_KLINE_ENDPOINT);
  url.search = new URLSearchParams({
    secid: `${market}.${code}`,
    klt: PERIODS[request.interval],
    fqt: "0",
    beg: request.start.replaceAll("-", ""),
    end: request.end.replaceAll("-", ""),
    fields1: statistics ? "f1,f2,f3,f4,f5,f6" : "f1,f2",
    fields2: statistics
      ? "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
      : "f51,f52,f53,f54,f55,f56",
    lmt: String(request.count),
  }).toString();
  const text = await http.getText(url, {
    ...(signal && { signal }),
    headers: { Referer: "https://quote.eastmoney.com/" },
  });
  const retrievedAt = new Date().toISOString();
  const response = parseSourceJson(text);
  if (response.rc !== 0)
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Eastmoney reported a market-data error.",
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
  const rows = sourceArray(data.klines, "klines").map((line) => {
    if (typeof line !== "string") sourceError("klines", "expected a CSV row");
    const fields = line.split(",");
    if (statistics ? fields.length !== 11 : fields.length < 6)
      sourceError("klines", "row does not contain the requested source fields");
    const bar: DailyValues = {
      date: sourceDate(fields[0]),
      open: sourceDecimal(fields[1], "open"),
      close: sourceDecimal(fields[2], "close"),
      high: sourceDecimal(fields[3], "high"),
      low: sourceDecimal(fields[4], "low"),
      volume: sourceDecimal(fields[5], "volume", SHARES_PER_LOT),
    };
    return statistics
      ? {
          ...bar,
          amount: sourceDecimal(fields[6], "amount"),
          amplitude: collectedNumber(fields[7], "amplitude"),
          changePercent: collectedNumber(fields[8], "changePercent"),
          change: collectedNumber(fields[9], "change"),
          turnover: collectedNumber(fields[10], "turnover"),
        }
      : bar;
  });
  return { rows, url: url.href, retrievedAt };
}
