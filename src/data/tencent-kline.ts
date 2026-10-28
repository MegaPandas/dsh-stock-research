import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { DAY_MS, sourceDecimal } from "./market.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

export const TENCENT_KLINE_ENDPOINT =
  "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
export type TencentPeriod = "day" | "week" | "month";

/** Maximum source periods intersecting an inclusive calendar-date range. */
export function tencentPeriodCount(
  start: string,
  end: string,
  period: TencentPeriod,
): number {
  if (period === "month")
    return (
      (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
      Number(end.slice(5, 7)) -
      Number(start.slice(5, 7)) +
      1
    );
  const startDay = Date.parse(start) / DAY_MS;
  const endDay = Date.parse(end) / DAY_MS;
  if (period === "day") return endDay - startDay + 1;
  // Unix epoch was Thursday; offset three days to group Monday–Sunday weeks.
  return Math.floor((endDay + 3) / 7) - Math.floor((startDay + 3) / 7) + 1;
}

/** Requests raw, unadjusted source periods; adjusted arrays are never substituted. */
export async function tencentKlines(
  http: HttpClient,
  request: {
    symbol: string;
    period: TencentPeriod;
    start: string;
    end: string;
    count: number;
    volumeScale: number;
  },
  signal?: AbortSignal,
) {
  const { symbol, period, start, end, count, volumeScale } = request;
  const url = new URL(TENCENT_KLINE_ENDPOINT);
  url.search = new URLSearchParams({
    param: `${symbol},${period},${start},${end},${count},`,
  }).toString();
  const response = parseSourceJson(
    await http.getText(url, {
      ...(signal && { signal }),
      headers: { Referer: "https://gu.qq.com/" },
    }),
  );
  const retrievedAt = new Date().toISOString();
  if (response.code !== 0)
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Tencent reported an error.",
      { cause: response },
    );
  const data = sourceObject(
    sourceObject(response.data, "data")[symbol],
    symbol,
  );
  const rows = sourceArray(data[period], period).map((value) => {
    const fields = sourceArray(value, `${period} row`);
    // Corporate-action dates may append an event object after OHLCV.
    if (fields.length < 6)
      sourceError(`${period} row`, "expected date and five OHLCV columns");
    return {
      date: sourceDate(fields[0]),
      open: sourceDecimal(fields[1], "open"),
      close: sourceDecimal(fields[2], "close"),
      high: sourceDecimal(fields[3], "high"),
      low: sourceDecimal(fields[4], "low"),
      volume: sourceDecimal(fields[5], "volume", volumeScale),
    };
  });
  return { rows, url: url.href, retrievedAt };
}
