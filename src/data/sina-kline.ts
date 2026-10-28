import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { sourceDecimal } from "./market.js";
import { sourceArray, sourceDate, sourceObject } from "./source.js";

export const SINA_KLINE_ENDPOINT =
  "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData";
const SINA_SCALES = { day: "240", week: "1200", month: "7200" } as const;
// This endpoint has no historical end-date parameter. Request a long rolling
// history so a past cutoff is filtered against source periods, not today's tail.
const HISTORY_COUNT = 20_000;

/** Native unadjusted OHLCV periods. Sina reports volume in shares. */
export async function sinaKlines(
  http: HttpClient,
  request: {
    symbol: string;
    period: "day" | "week" | "month";
    start: string;
    end: string;
    count: number;
    volumeScale: number;
  },
  signal?: AbortSignal,
) {
  const url = new URL(SINA_KLINE_ENDPOINT);
  url.search = new URLSearchParams({
    symbol: request.symbol,
    scale: SINA_SCALES[request.period],
    ma: "no",
    datalen: String(HISTORY_COUNT),
  }).toString();
  const text = await http.getText(url, { ...(signal && { signal }) });
  const retrievedAt = new Date().toISOString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Sina returned invalid K-line JSON.",
      { cause },
    );
  }
  const rows = sourceArray(parsed, "Sina K-lines")
    .map((item) => {
      const raw = sourceObject(item, "Sina K-line");
      return {
        date: sourceDate(raw.day),
        open: sourceDecimal(raw.open, "open"),
        high: sourceDecimal(raw.high, "high"),
        low: sourceDecimal(raw.low, "low"),
        close: sourceDecimal(raw.close, "close"),
        volume: sourceDecimal(raw.volume, "volume", request.volumeScale),
      };
    })
    .filter((row) => row.date >= request.start && row.date <= request.end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-request.count);
  if (rows.length === 0)
    throw new ResearchError(
      "DATA_INSUFFICIENT",
      "Sina's rolling history contains no observations within the requested historical window.",
    );
  return { rows, url: url.href, retrievedAt };
}
