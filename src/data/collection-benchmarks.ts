import type {
  CollectedTableData,
  CollectionColumn,
  CollectionRow,
  CollectionTask,
} from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { collectedEnvelope, collectedNumber } from "./collection-utils.js";
import type { HttpClient } from "./http.js";
import { type XueqiuClient, xueqiuDate } from "./xueqiu.js";
import { SINA_KLINE_ENDPOINT, sinaKlines } from "./sina-kline.js";
import {
  TENCENT_KLINE_ENDPOINT,
  tencentKlines,
  tencentPeriodCount,
} from "./tencent-kline.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const DAY_MS = 86_400_000;
const WINDOWS = [
  {
    id: "daily",
    interval: "1d",
    klt: "101",
    count: 60,
    days: 120,
    title: "日线",
  },
  {
    id: "weekly",
    interval: "1wk",
    klt: "102",
    count: 52,
    days: 52 * 7 + 42,
    title: "周线",
  },
  {
    id: "monthly",
    interval: "1mo",
    klt: "103",
    count: 36,
    days: 0,
    title: "月线",
  },
] as const;
type Window = (typeof WINDOWS)[number];
interface Benchmark {
  id: string;
  name: string;
  assetCode: string;
  assetType: "index" | "gold" | "fx" | "dollarIndex";
  unit: string;
  calendar: "china_exchange" | "global_weekdays_utc";
  secid?: string;
  yahooSymbol?: string;
  yahooAlias?: string;
  sinaForexSymbol?: string;
  xueqiuSymbol?: string;
  currency?: string;
}

// Identities are fixed from the publisher's product metadata, not selected by an Agent.
const BENCHMARKS: readonly Benchmark[] = [
  {
    id: "shanghai",
    name: "上证指数",
    assetCode: "CN:000001.SH",
    assetType: "index",
    unit: "index",
    calendar: "china_exchange",
    secid: "1.000001",
  },
  {
    id: "shenzhen",
    name: "深证成指",
    assetCode: "CN:399001.SZ",
    assetType: "index",
    unit: "index",
    calendar: "china_exchange",
    secid: "0.399001",
  },
  {
    id: "csi300",
    name: "沪深300",
    assetCode: "CN:000300.SH",
    assetType: "index",
    unit: "index",
    calendar: "china_exchange",
    secid: "1.000300",
  },
  {
    id: "chinext",
    name: "创业板指",
    assetCode: "CN:399006.SZ",
    assetType: "index",
    unit: "index",
    calendar: "china_exchange",
    secid: "0.399006",
  },
  {
    id: "gold",
    name: "现货黄金XAU/USD",
    assetCode: "XAU/USD",
    assetType: "gold",
    unit: "USD/troy_ounce",
    calendar: "global_weekdays_utc",
    secid: "122.XAU",
    sinaForexSymbol: "fx_sxauusd",
    currency: "USD",
  },
  {
    id: "dxy",
    name: "美元指数DXY",
    assetCode: "DXY",
    assetType: "dollarIndex",
    unit: "index",
    calendar: "global_weekdays_utc",
    secid: "100.UDI",
    yahooSymbol: "DX-Y.NYB",
    currency: "USD",
  },
  {
    id: "usdcny",
    name: "美元兑在岸人民币",
    assetCode: "USD/CNY",
    assetType: "fx",
    unit: "CNY/USD",
    calendar: "global_weekdays_utc",
    yahooSymbol: "CNY=X",
    xueqiuSymbol: "USDCNY.FX",
    currency: "CNY",
  },
  {
    id: "usdcnh",
    name: "美元兑离岸人民币",
    assetCode: "USD/CNH",
    assetType: "fx",
    unit: "CNH/USD",
    calendar: "global_weekdays_utc",
    secid: "133.USDCNH",
    sinaForexSymbol: "fx_susdcnh",
    xueqiuSymbol: "USDCNH.FX",
    currency: "CNH",
  },
  {
    id: "eurusd",
    name: "欧元兑美元",
    assetCode: "EUR/USD",
    assetType: "fx",
    unit: "USD/EUR",
    calendar: "global_weekdays_utc",
    secid: "119.EURUSD",
    yahooSymbol: "EURUSD=X",
    xueqiuSymbol: "EURUSD.FX",
    currency: "USD",
  },
  {
    id: "usdjpy",
    name: "美元兑日元",
    assetCode: "USD/JPY",
    assetType: "fx",
    unit: "JPY/USD",
    calendar: "global_weekdays_utc",
    secid: "119.USDJPY",
    yahooSymbol: "JPY=X",
    yahooAlias: "USDJPY=X",
    xueqiuSymbol: "USDJPY.FX",
    currency: "JPY",
  },
];
const chinaDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
function monthEnd(date: string): string {
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
}
function periodEnd(date: string, window: Window): string {
  if (window.interval === "1d") return date;
  if (window.interval === "1mo") return monthEnd(date);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, (5 - weekday + 7) % 7);
}
function closeTime(date: string, asset: Benchmark): string {
  return asset.calendar === "china_exchange"
    ? `${date}T07:00:00.000Z`
    : `${date}T23:59:59.999Z`;
}
function bounds(scope: ResearchScope, asset: Benchmark, window: Window) {
  const cutoffDate =
    asset.calendar === "china_exchange"
      ? chinaDate.format(new Date(scope.cutoff))
      : scope.cutoff.slice(0, 10);
  const date = scope.date < cutoffDate ? scope.date : cutoffDate;
  let end = periodEnd(date, window);
  if (closeTime(end, asset) > scope.cutoff)
    end =
      window.interval === "1d"
        ? addDays(end, -1)
        : window.interval === "1wk"
          ? addDays(end, -7)
          : addDays(`${date.slice(0, 7)}-01`, -1);
  const start =
    window.interval === "1mo"
      ? new Date(
          Date.UTC(
            Number(end.slice(0, 4)),
            Number(end.slice(5, 7)) - window.count,
            1,
          ),
        )
          .toISOString()
          .slice(0, 10)
      : addDays(end, -window.days);
  return { start, end };
}
function columns(
  asset: Benchmark,
  includeOhlc: boolean,
): Record<string, CollectionColumn> {
  if (!includeOhlc)
    return {
      close: {
        label: asset.assetType === "fx" ? "收盘汇率" : "收盘",
        unit: asset.unit,
      },
    };
  return {
    open: { label: "开盘", unit: asset.unit },
    close: { label: "收盘", unit: asset.unit },
    high: { label: "最高", unit: asset.unit },
    low: { label: "最低", unit: asset.unit },
    amplitude: { label: "振幅", unit: "percent" },
    changePercent: { label: "涨跌幅", unit: "percent" },
    change: { label: "涨跌额", unit: asset.unit },
    ...(asset.assetType === "index"
      ? {
          volume: { label: "成交量（手）", unit: "lots" },
          amount: { label: "成交额", unit: "CNY" },
        }
      : {}),
  };
}
function makeRow(
  date: string,
  values: CollectionRow["values"],
  asset: Benchmark,
  window: Window,
): CollectionRow {
  const { open, high, low, close } = values;
  for (const key of ["open", "close", "high", "low"])
    if (values[key] !== null && values[key]! <= 0)
      sourceError(date, "benchmark OHLC must be positive or missing");
  if (
    (high !== null && low !== null && high! < low!) ||
    (high !== null &&
      ((open !== null && open! > high!) ||
        (close !== null && close! > high!))) ||
    (low !== null &&
      ((open !== null && open! < low!) || (close !== null && close! < low!)))
  )
    sourceError(date, "benchmark OHLC contradicts the declared high/low range");
  return {
    date,
    asOf: closeTime(periodEnd(date, window), asset),
    availableAt: null,
    complete: true,
    values,
  };
}
function finish(
  rows: CollectionRow[],
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
  provider: string,
  url: string,
  retrievedAt: string,
  sourceName: string,
) {
  const { start, end } = bounds(scope, asset, window);
  const selected = rows
    .filter(
      (row) =>
        row.date >= start &&
        row.date <= end &&
        row.asOf <= scope.cutoff &&
        !(
          asset.calendar === "global_weekdays_utc" &&
          window.interval === "1d" &&
          [0, 6].includes(new Date(`${row.date}T00:00:00.000Z`).getUTCDay())
        ),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-window.count);
  const data: CollectedTableData = {
    table: `benchmark.${asset.id}.${window.id}`,
    title: `${asset.name}${window.title}`,
    interval: window.interval,
    columns: columns(asset, provider !== "yahoo"),
    rows: selected,
    ...(asset.currency === undefined ? {} : { currency: asset.currency }),
    basis:
      provider === "yahoo" ? "source_reported_close" : "source_reported_ohlc",
    attributes: {
      assetCode: asset.assetCode,
      name: asset.name,
      sourceName,
      unit: asset.unit,
      assetType: asset.assetType,
      calendar: asset.calendar,
      timeBasis:
        asset.calendar === "china_exchange"
          ? "China index sessions; completed day/week/month at 15:00 Asia/Shanghai"
          : "Source trading date; conservative UTC day-end, Friday-end and month-end completion",
      ...(asset.assetType === "gold" ? { instrument: "spot" } : {}),
      ...(asset.assetType === "fx" ? { quoteDirection: asset.unit } : {}),
    },
  };
  const envelope = collectedEnvelope(
    scope,
    "market",
    data,
    provider,
    url,
    retrievedAt,
  );
  if (provider === "sina" && asset.assetType === "gold") {
    envelope.data.attributes!.sourceMethodology =
      "publisher_calculated_spot_cross";
    envelope.gaps.push({
      code: "incomparable",
      field: "/data/attributes/sourceMethodology",
      detail:
        "Sina labels this gold-ounce/USD spot cross as calculated by Sina Finance; it is a publisher-calculated spot quote rather than an exchange fixing.",
    });
  }
  if (provider === "yahoo")
    envelope.gaps.push({
      code: "incomparable",
      field: "/data/columns/ohlc",
      detail:
        "Yahoo benchmark OHLC range consistency has not been established; this dataset only supplies source-reported closing values.",
    });
  if (selected.length < window.count)
    envelope.gaps.push({
      code: "missing",
      field: "/data/rows",
      detail: `The source supplies ${selected.length} eligible ${window.id} observations; the fixed window requests ${window.count}.`,
    });
  if (asset.assetType !== "index")
    envelope.gaps.push({
      code: "missing",
      field: "/data/columns/volume",
      detail:
        "The source's volume quantity and unit have not been established for this benchmark; zero placeholders are not reported as trading volume.",
    });
  return envelope;
}

function eastmoneyTask(
  http: HttpClient,
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
): CollectionTask {
  const { start, end } = bounds(scope, asset, window);
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid: asset.secid!,
    klt: window.klt,
    fqt: "0",
    beg: start.replaceAll("-", ""),
    end: end.replaceAll("-", ""),
    lmt: String(window.count),
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  }).toString();
  return {
    id: `benchmark.${asset.id}.${window.id}`,
    dataset: "market",
    provider: "eastmoney",
    enabledBy: ["benchmarks", "eastmoney"],
    endpoint: url.origin + url.pathname,
    async run(signal) {
      const response = parseSourceJson(
        await http.getText(url, {
          ...(signal && { signal }),
          headers: { Referer: "https://quote.eastmoney.com/" },
        }),
      );
      const retrievedAt = new Date().toISOString();
      if (response.rc !== 0)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Eastmoney reported a benchmark market-data error.",
          { cause: response },
        );
      if (response.data === null)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          `No source data for ${asset.assetCode}.`,
        );
      const data = sourceObject(response.data, "data");
      const [market, code] = asset.secid!.split(".");
      if (data.code !== code || data.market !== Number(market))
        sourceError(
          "data",
          "benchmark identity does not match the requested source code",
        );
      if (typeof data.name !== "string" || data.name.trim() === "")
        sourceError("data.name", "expected the source benchmark name");
      const rows = sourceArray(data.klines, "data.klines").map((line) => {
        if (typeof line !== "string")
          sourceError("data.klines", "expected a CSV row");
        const fields = line.split(",");
        if (fields.length !== 11)
          sourceError(
            "data.klines",
            "expected the requested benchmark source fields",
          );
        const date = sourceDate(fields[0]);
        const values = Object.fromEntries(
          (
            [
              ["open", 1],
              ["close", 2],
              ["high", 3],
              ["low", 4],
              ["amplitude", 7],
              ["changePercent", 8],
              ["change", 9],
            ] as const
          ).map(([key, index]) => [key, collectedNumber(fields[index], key)]),
        );
        if (asset.assetType === "index") {
          values.volume = collectedNumber(fields[5], "volume");
          values.amount = collectedNumber(fields[6], "amount");
          for (const key of ["volume", "amount"])
            if (values[key] !== null && values[key]! < 0)
              sourceError(
                key,
                "expected a nonnegative benchmark trading quantity",
              );
        }
        return makeRow(date, values, asset, window);
      });
      return finish(
        rows,
        scope,
        asset,
        window,
        "eastmoney",
        url.href,
        retrievedAt,
        data.name,
      );
    },
  };
}

function yahooTask(
  http: HttpClient,
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
): CollectionTask {
  const { start, end } = bounds(scope, asset, window);
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.yahooSymbol!)}`,
  );
  // London midnight is Sunday UTC during BST; include the preceding UTC day and filter by source dates.
  url.search = new URLSearchParams({
    interval: window.interval,
    period1: String(Date.parse(`${addDays(start, -1)}T00:00:00.000Z`) / 1000),
    period2: String(Date.parse(`${addDays(end, 1)}T00:00:00.000Z`) / 1000),
  }).toString();
  return {
    id: `benchmark.${asset.id}.${window.id}`,
    dataset: "market",
    provider: "yahoo",
    enabledBy: ["benchmarks", "yahoo"],
    endpoint: url.origin + url.pathname,
    async run(signal) {
      const response = parseSourceJson(
        await http.getText(url, {
          ...(signal && { signal }),
          headers: { "User-Agent": "Mozilla/5.0" },
        }),
      );
      const retrievedAt = new Date().toISOString();
      const chart = sourceObject(response.chart, "chart");
      if (chart.error !== null)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Yahoo reported a benchmark chart error.",
          { cause: chart.error },
        );
      const result = sourceArray(chart.result, "chart.result");
      if (result.length !== 1)
        sourceError("chart.result", "expected one benchmark chart");
      const data = sourceObject(result[0], "chart.result[0]");
      const meta = sourceObject(data.meta, "meta");
      if (
        !(
          meta.symbol === asset.yahooSymbol ||
          (asset.id === "usdcny" && meta.symbol === "USDCNY=X") ||
          (asset.yahooAlias !== undefined && meta.symbol === asset.yahooAlias)
        ) ||
        meta.instrumentType !==
          (asset.assetType === "dollarIndex" ? "INDEX" : "CURRENCY") ||
        meta.currency !== asset.currency ||
        meta.dataGranularity !== window.interval
      )
        sourceError(
          "meta",
          "benchmark symbol, currency, instrument type or interval does not match the request",
        );
      if (typeof meta.exchangeTimezoneName !== "string")
        sourceError(
          "meta.exchangeTimezoneName",
          "expected the source trading timezone",
        );
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat("sv-SE", {
          timeZone: meta.exchangeTimezoneName,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
      } catch {
        sourceError(
          "meta.exchangeTimezoneName",
          "expected a valid IANA timezone",
        );
      }
      const timestamps = sourceArray(data.timestamp, "timestamp");
      const indicators = sourceObject(data.indicators, "indicators");
      const quote = sourceObject(
        sourceArray(indicators.quote, "indicators.quote")[0],
        "indicators.quote[0]",
      );
      const closes = sourceArray(quote.close, "quote.close");
      if (closes.length !== timestamps.length)
        sourceError(
          "quote.close",
          "source timestamps and closing rates must have equal lengths",
        );
      const rows = timestamps.map((timestamp, index) => {
        if (typeof timestamp !== "number" || !Number.isFinite(timestamp))
          sourceError("timestamp", "expected Unix seconds");
        const date = sourceDate(formatter.format(new Date(timestamp * 1000)));
        const close = collectedNumber(closes[index], "close");
        if (close !== null && close <= 0)
          sourceError(
            "quote.close",
            "closing exchange rates must be positive or missing",
          );
        return {
          date,
          asOf: closeTime(periodEnd(date, window), asset),
          availableAt: null,
          complete: true,
          values: { close },
        };
      });
      const envelope = finish(
        rows,
        scope,
        asset,
        window,
        "yahoo",
        url.href,
        retrievedAt,
        typeof meta.longName === "string" ? meta.longName : asset.name,
      );
      envelope.data.attributes!.sourceTimeZone = meta.exchangeTimezoneName;
      return envelope;
    },
  };
}

function xueqiuTask(
  client: XueqiuClient,
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
): CollectionTask {
  const path = "/v5/stock/chart/kline.json";
  const { end } = bounds(scope, asset, window);
  return {
    id: `benchmark.${asset.id}.${window.id}`,
    dataset: "market",
    provider: "xueqiu",
    enabledBy: ["benchmarks", "xueqiu"],
    endpoint: `https://stock.xueqiu.com${path}`,
    async run(signal) {
      const response = await client.get(
        path,
        {
          symbol: asset.xueqiuSymbol!,
          period:
            window.interval === "1d"
              ? "day"
              : window.interval === "1wk"
                ? "week"
                : "month",
          type: "normal",
          begin: String(Date.parse(`${end}T23:59:59.999Z`)),
          count: String(-window.count),
        },
        signal,
      );
      if (response.data.symbol !== asset.xueqiuSymbol)
        sourceError(
          "symbol",
          "benchmark identity does not match the requested Xueqiu symbol",
        );
      const fields = sourceArray(response.data.column, "column");
      const indices = new Map(fields.map((field, index) => [field, index]));
      for (const field of ["timestamp", "open", "high", "low", "close"])
        if (!indices.has(field)) sourceError("column", `missing ${field}`);
      const rows = sourceArray(response.data.item, "item").map((item) => {
        const row = sourceArray(item, "item[]");
        if (row.length !== fields.length)
          sourceError("item[]", "row length does not match the column count");
        const number = (field: string) => {
          const index = indices.get(field);
          return index === undefined
            ? null
            : collectedNumber(row[index], field);
        };
        return makeRow(
          xueqiuDate(row[indices.get("timestamp")!], "timestamp"),
          {
            open: number("open"),
            high: number("high"),
            low: number("low"),
            close: number("close"),
            change: number("chg"),
            changePercent: number("percent"),
            amplitude: null,
          },
          asset,
          window,
        );
      });
      const result = finish(
        rows,
        scope,
        asset,
        window,
        "xueqiu",
        response.url,
        response.retrievedAt,
        asset.name,
      );
      result.data.attributes!.sourceTimeZone = "Asia/Shanghai";
      return result;
    },
  };
}

function tencentTask(
  http: HttpClient,
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
): CollectionTask {
  const { start, end } = bounds(scope, asset, window);
  const [market, code] = asset.secid!.split(".");
  return {
    id: `benchmark.${asset.id}.${window.id}`,
    dataset: "market",
    provider: "tencent",
    enabledBy: ["benchmarks", "tencent"],
    endpoint: TENCENT_KLINE_ENDPOINT,
    async run(signal) {
      const period =
        window.interval === "1d"
          ? "day"
          : window.interval === "1wk"
            ? "week"
            : "month";
      const response = await tencentKlines(
        http,
        {
          symbol: `${market === "1" ? "sh" : "sz"}${code}`,
          period,
          start,
          end,
          count: tencentPeriodCount(start, end, period),
          volumeScale: 1,
        },
        signal,
      );
      const rows = response.rows.map(({ date, ...raw }) =>
        makeRow(
          date,
          {
            ...raw,
            amount: null,
            amplitude: null,
            changePercent: null,
            change: null,
          },
          asset,
          window,
        ),
      );
      return finish(
        rows.filter((row) => periodEnd(row.date, window) <= end),
        scope,
        asset,
        window,
        "tencent",
        response.url,
        response.retrievedAt,
        asset.name,
      );
    },
  };
}

// The publisher SDK datas/k.js declares daily FX CSV as date,open,low,high,close,volume.
// Its week/month bars are client-side aggregations, so only native daily bars are used here.
function sinaForexTask(
  http: HttpClient,
  scope: ResearchScope,
  asset: Benchmark,
  window: Window,
): CollectionTask {
  const url = new URL(
    "https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/benchmark=/NewForexService.getDayKLine",
  );
  url.searchParams.set("symbol", asset.sinaForexSymbol!);
  return {
    id: `benchmark.${asset.id}.${window.id}`,
    dataset: "market",
    provider: "sina",
    enabledBy: ["benchmarks", "sina"],
    endpoint: url.origin + url.pathname,
    async run(signal) {
      const text = await http.getText(url, {
        ...(signal && { signal }),
        headers: { Referer: "https://finance.sina.com.cn/" },
      });
      const match = /benchmark=\(("(?:[^"\\]|\\.)*")\);\s*$/.exec(text);
      if (!match)
        sourceError(
          "response",
          "expected the requested Sina FX callback with daily CSV",
        );
      let csv: string;
      try {
        csv = JSON.parse(match[1]!);
      } catch (cause) {
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Sina returned invalid FX JSON.",
          { cause },
        );
      }
      const rows = csv.split("|").map((line) => {
        const fields = line.split(",");
        if (fields.length !== 5 && fields.length !== 6)
          sourceError("response", "expected daily Sina FX fields");
        return makeRow(
          sourceDate(fields[0]),
          {
            open: collectedNumber(fields[1], "open"),
            low: collectedNumber(fields[2], "low"),
            high: collectedNumber(fields[3], "high"),
            close: collectedNumber(fields[4], "close"),
            amplitude: null,
            changePercent: null,
            change: null,
          },
          asset,
          window,
        );
      });
      return finish(
        rows,
        scope,
        asset,
        window,
        "sina",
        url.href,
        new Date().toISOString(),
        asset.name,
      );
    },
  };
}

/** Fixed benchmark instruments and period requests; no source discovery occurs during collection. */
export function createBenchmarkMarketTasks(
  http: HttpClient,
  scope: ResearchScope,
  xueqiu?: XueqiuClient,
): CollectionTask[] {
  return BENCHMARKS.flatMap((asset) =>
    WINDOWS.flatMap((window) => {
      const task =
        asset.secid !== undefined
          ? eastmoneyTask(http.forSource("eastmoney"), scope, asset, window)
          : yahooTask(http.forSource("yahoo"), scope, asset, window);
      task.enabledBy = ["benchmarks"];
      const candidates = [task];
      if (asset.calendar === "china_exchange" && asset.assetType === "index")
        candidates.push(
          tencentTask(http.forSource("tencent"), scope, asset, window),
        );
      if (asset.calendar === "china_exchange") {
        const { start, end } = bounds(scope, asset, window);
        const [market, code] = asset.secid!.split(".");
        candidates.push({
          id: task.id,
          dataset: "market",
          provider: "sina",
          enabledBy: ["benchmarks", "sina"],
          endpoint: SINA_KLINE_ENDPOINT,
          async run(signal) {
            const response = await sinaKlines(
              http.forSource("sina"),
              {
                symbol: `${market === "1" ? "sh" : "sz"}${code}`,
                period:
                  window.interval === "1d"
                    ? "day"
                    : window.interval === "1wk"
                      ? "week"
                      : "month",
                start,
                end,
                count: window.count,
                volumeScale: 0.01,
              },
              signal,
            );
            return finish(
              response.rows.map(({ date, ...values }) =>
                makeRow(
                  date,
                  {
                    ...values,
                    amount: null,
                    amplitude: null,
                    changePercent: null,
                    change: null,
                  },
                  asset,
                  window,
                ),
              ),
              scope,
              asset,
              window,
              "sina",
              response.url,
              response.retrievedAt,
              asset.name,
            );
          },
        });
      } else if (asset.secid !== undefined && asset.yahooSymbol !== undefined) {
        candidates.push(
          yahooTask(http.forSource("yahoo"), scope, asset, window),
        );
      } else if (
        asset.sinaForexSymbol !== undefined &&
        window.interval === "1d"
      ) {
        candidates.push(
          sinaForexTask(http.forSource("sina"), scope, asset, window),
        );
      }
      if (xueqiu !== undefined && asset.xueqiuSymbol !== undefined) {
        candidates.splice(1, 0, xueqiuTask(xueqiu, scope, asset, window));
      }
      return candidates;
    }),
  );
}
