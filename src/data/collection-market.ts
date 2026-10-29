import type {
  CollectedTableData,
  CollectionColumn,
  CollectionRow,
  CollectionTask,
} from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { collectedEnvelope, collectedNumber } from "./collection-utils.js";
import { sessionEnd } from "./market-session.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";
import { SESSION_DATES } from "./market-session.js";
import {
  TENCENT_KLINE_ENDPOINT,
  tencentKlines,
  tencentPeriodCount,
} from "./tencent-kline.js";
import { SINA_KLINE_ENDPOINT, sinaKlines } from "./sina-kline.js";
import { type XueqiuClient, xueqiuDate, xueqiuTimestamp } from "./xueqiu.js";

const DAY_MS = 86_400_000;
const MARKET_WINDOWS = [
  { interval: "1d", id: "daily", klt: "101", count: 60, title: "日线" },
  { interval: "1wk", id: "weekly", klt: "102", count: 52, title: "周线" },
  { interval: "1mo", id: "monthly", klt: "103", count: 36, title: "月线" },
] as const;
const localDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const priceColumn = (label: string): CollectionColumn => ({
  label,
  unit: "CNY/share",
  price: true,
});
const MARKET_COLUMNS: Record<string, CollectionColumn> = {
  open: priceColumn("开盘价"),
  close: priceColumn("收盘价"),
  high: priceColumn("最高价"),
  low: priceColumn("最低价"),
  volume: { label: "成交量", unit: "shares" },
  amount: { label: "成交额", unit: "CNY" },
  amplitude: { label: "振幅", unit: "percent" },
  changePercent: { label: "涨跌幅", unit: "percent" },
  change: { label: "涨跌额", unit: "CNY/share" },
  turnover: { label: "换手率", unit: "percent" },
};
const KLINE_FIELDS = Object.keys(MARKET_COLUMNS);

function urlWith(base: string, parameters: Record<string, string>): string {
  const url = new URL(base);
  url.search = new URLSearchParams(parameters).toString();
  return url.href;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function monthEnd(date: string): string {
  const time = new Date(`${date}T00:00:00.000Z`);
  return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

function periodEnd(date: string, interval: "1d" | "1wk" | "1mo"): string {
  if (interval === "1d") return date;
  if (interval === "1mo") return monthEnd(date);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, (5 - weekday + 7) % 7);
}

function completedEnd(
  scope: ResearchScope,
  interval: "1d" | "1wk" | "1mo",
): string {
  const date =
    localDate.format(new Date(scope.cutoff)) < scope.date
      ? localDate.format(new Date(scope.cutoff))
      : scope.date;
  if (interval === "1d")
    return sessionEnd(date, scope.security) <= scope.cutoff
      ? date
      : addDays(date, -1);
  const end = periodEnd(date, interval);
  if (sessionEnd(end, scope.security) <= scope.cutoff) return end;
  return interval === "1wk"
    ? addDays(end, -7)
    : addDays(`${date.slice(0, 7)}-01`, -1);
}

function sourceRow(
  date: string,
  values: CollectionRow["values"],
  scope: ResearchScope,
  interval: "1d" | "1wk" | "1mo" = "1d",
): CollectionRow {
  const asOf = sessionEnd(periodEnd(date, interval), scope.security);
  return {
    date,
    asOf,
    availableAt: null,
    complete: asOf <= scope.cutoff,
    values,
  };
}

function windowGap(data: CollectedTableData, count: number) {
  return data.rows.length < count
    ? [
        {
          code: "missing" as const,
          field: "/data/rows",
          detail: `The source returned ${data.rows.length} observations; the fixed window requests ${count}.`,
        },
      ]
    : [];
}

function validatePrices(values: CollectionRow["values"], date: string): void {
  for (const key of ["open", "close", "high", "low", "volume", "amount"])
    if (values[key] !== null && values[key]! < 0)
      sourceError(date, `${key} must be nonnegative`);
  const { open, close, high, low } = values;
  if (
    (high !== null && low !== null && high! < low!) ||
    (high !== null &&
      ((open !== null && open! > high!) ||
        (close !== null && close! > high!))) ||
    (low !== null &&
      ((open !== null && open! < low!) || (close !== null && close! < low!)))
  )
    sourceError(date, "OHLC values contradict the declared range");
}

function klineTasks(
  http: HttpClient,
  scope: ResearchScope,
  window: (typeof MARKET_WINDOWS)[number],
  tencent: HttpClient,
  sina: HttpClient,
  xueqiu?: XueqiuClient,
): CollectionTask[] {
  const end = completedEnd(scope, window.interval);
  const start =
    window.interval === "1d"
      ? addDays(end, -120)
      : window.interval === "1wk"
        ? addDays(end, -(window.count * 7 + 42))
        : new Date(
            Date.UTC(
              Number(end.slice(0, 4)),
              Number(end.slice(5, 7)) - window.count,
              1,
            ),
          )
            .toISOString()
            .slice(0, 10);
  const code = scope.security.symbol.slice(0, 6);
  const market = scope.security.exchange === "SH" ? 1 : 0;
  const url = urlWith("https://push2his.eastmoney.com/api/qt/stock/kline/get", {
    secid: `${market}.${code}`,
    klt: window.klt,
    fqt: "0",
    beg: start.replaceAll("-", ""),
    end: end.replaceAll("-", ""),
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    lmt: String(window.count),
  });
  const task: CollectionTask = {
    id: `market.${window.id}`,
    dataset: "market",
    provider: "eastmoney",
    enabledBy: ["eastmoney-market"],
    endpoint: new URL(url).origin + new URL(url).pathname,
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
          "Eastmoney reported a market-data error.",
          { cause: response },
        );
      if (response.data === null)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          "Eastmoney returned no stock data.",
        );
      const raw = sourceObject(response.data, "data");
      if (raw.code !== code || raw.market !== market)
        sourceError("data", "security does not match the request");
      const rows = sourceArray(raw.klines, "klines")
        .map((line) => {
          if (typeof line !== "string")
            sourceError("klines", "expected a CSV row");
          const fields = line.split(",");
          if (fields.length !== 11)
            sourceError(
              "klines",
              "expected date and ten source-reported quantities",
            );
          const date = sourceDate(fields[0]);
          const values = Object.fromEntries(
            KLINE_FIELDS.map((key, index) => [
              key,
              collectedNumber(fields[index + 1], key),
            ]),
          );
          if (values.volume !== null) values.volume! *= 100;
          validatePrices(values, date);
          return sourceRow(date, values, scope, window.interval);
        })
        .filter((row) => row.date <= end && row.complete)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-window.count);
      const data: CollectedTableData = {
        table: task.id,
        title: window.title,
        columns: MARKET_COLUMNS,
        rows,
        currency: "CNY",
        adjustment: "unadjusted",
        interval: window.interval,
      };
      const envelope = collectedEnvelope(
        scope,
        "market",
        data,
        "eastmoney",
        url,
        retrievedAt,
      );
      envelope.gaps.push(...windowGap(data, window.count));
      if (window.interval !== "1d")
        envelope.gaps.push({
          code: "missing",
          field: "/data/columns/ma",
          detail:
            "This period endpoint does not supply source-reported moving averages; none are calculated locally.",
        });
      return envelope;
    },
  };
  function backup(provider: "tencent" | "sina"): CollectionTask {
    return {
      id: task.id,
      dataset: "market",
      provider,
      enabledBy: [provider],
      endpoint:
        provider === "tencent" ? TENCENT_KLINE_ENDPOINT : SINA_KLINE_ENDPOINT,
      async run(signal) {
        const requestedStart =
          window.interval === "1d" ? addDays(end, -180) : start;
        const startDate =
          window.interval === "1d" && requestedStart < SESSION_DATES.start
            ? SESSION_DATES.start
            : requestedStart;
        const symbol = scope.security.exchange.toLowerCase() + code;
        const period =
          window.interval === "1d"
            ? "day"
            : window.interval === "1wk"
              ? "week"
              : "month";
        const response = await (
          provider === "tencent" ? tencentKlines : sinaKlines
        )(
          provider === "tencent" ? tencent : sina,
          {
            symbol,
            period,
            start: startDate,
            end,
            count: tencentPeriodCount(startDate, end, period),
            volumeScale:
              provider === "sina" ||
              symbol.startsWith("sh688") ||
              symbol.startsWith("sh689")
                ? 1
                : 100,
          },
          signal,
        );
        const rows = response.rows
          .map(({ date, ...raw }) => {
            const values = Object.fromEntries(
              KLINE_FIELDS.map((key) => [
                key,
                key in raw ? raw[key as keyof typeof raw] : null,
              ]),
            );
            validatePrices(values, date);
            return sourceRow(date, values, scope, window.interval);
          })
          .filter(
            (row) =>
              row.date >= startDate &&
              periodEnd(row.date, window.interval) <= end &&
              row.complete,
          )
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-window.count);
        const data: CollectedTableData = {
          table: task.id,
          title: window.title,
          columns: MARKET_COLUMNS,
          rows,
          currency: "CNY",
          adjustment: "unadjusted",
          interval: window.interval,
        };
        const result = collectedEnvelope(
          scope,
          "market",
          data,
          provider,
          response.url,
          response.retrievedAt,
        );
        result.gaps.push(...windowGap(data, window.count));
        if (window.interval !== "1d")
          result.gaps.push({
            code: "missing",
            field: "/data/columns/ma",
            detail:
              "This period endpoint does not supply source-reported moving averages; none are calculated locally.",
          });
        return result;
      },
    };
  }
  const candidates = [task, backup("tencent"), backup("sina")];
  if (xueqiu !== undefined) {
    const client = xueqiu;
    candidates.push({
      id: task.id,
      dataset: "market",
      provider: "xueqiu",
      enabledBy: ["xueqiu"],
      endpoint: "https://stock.xueqiu.com/v5/stock/chart/kline.json",
      async run(signal) {
        const symbol = scope.security.exchange + code;
        const response = await client.get(
          "/v5/stock/chart/kline.json",
          {
            symbol,
            begin: String(Date.parse(sessionEnd(end, scope.security))),
            period:
              window.interval === "1d"
                ? "day"
                : window.interval === "1wk"
                  ? "week"
                  : "month",
            type: "normal",
            count: String(-window.count),
            indicator: "kline",
          },
          signal,
        );
        const raw = response.data;
        if (raw.symbol !== symbol)
          sourceError("symbol", "security does not match the request");
        const columns = sourceArray(raw.column, "column").map((column) => {
          if (typeof column !== "string")
            sourceError("column", "expected column names");
          return column;
        });
        if (new Set(columns).size !== columns.length)
          sourceError("column", "duplicate column names");
        for (const field of [
          "timestamp",
          "open",
          "close",
          "high",
          "low",
          "volume",
        ])
          if (!columns.includes(field))
            sourceError("column", `missing ${field} column`);
        const mapping = {
          open: "open",
          close: "close",
          high: "high",
          low: "low",
          volume: "volume",
          amount: "amount",
          amplitude: "amplitude",
          changePercent: "percent",
          change: "chg",
          turnover: "turnoverrate",
        };
        const rows = sourceArray(raw.item, "item")
          .map((item) => {
            const values = sourceArray(item, "item row");
            if (values.length !== columns.length)
              sourceError("item", "row length does not match the columns");
            const record = Object.fromEntries(
              columns.map((column, index) => [column, values[index]]),
            );
            const date = xueqiuDate(record.timestamp, "timestamp");
            const quantities = Object.fromEntries(
              Object.entries(mapping).map(([key, field]) => [
                key,
                collectedNumber(record[field], field),
              ]),
            );
            validatePrices(quantities, date);
            return sourceRow(date, quantities, scope, window.interval);
          })
          .filter(
            (row) =>
              periodEnd(row.date, window.interval) <= end && row.complete,
          )
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-window.count);
        const data: CollectedTableData = {
          table: task.id,
          title: window.title,
          columns: MARKET_COLUMNS,
          rows,
          currency: "CNY",
          adjustment: "unadjusted",
          interval: window.interval,
        };
        const envelope = collectedEnvelope(
          scope,
          "market",
          data,
          "xueqiu",
          response.url,
          response.retrievedAt,
        );
        envelope.gaps.push(...windowGap(data, window.count));
        if (window.interval !== "1d")
          envelope.gaps.push({
            code: "missing",
            field: "/data/columns/ma",
            detail:
              "This period endpoint does not supply source-reported moving averages; none are calculated locally.",
          });
        return envelope;
      },
    });
  }
  return candidates;
}

function averagesTask(http: HttpClient, scope: ResearchScope): CollectionTask {
  const symbol =
    scope.security.exchange.toLowerCase() + scope.security.symbol.slice(0, 6);
  const url = urlWith(SINA_KLINE_ENDPOINT, {
    symbol,
    scale: "240",
    ma: "5,10,20,30,60",
    datalen: "60",
  });
  const columns: Record<string, CollectionColumn> = {};
  for (const period of [5, 10, 20, 30]) {
    columns[`ma${period}`] = { label: `MA${period}`, unit: "CNY/share" };
    columns[`volumeMa${period}`] = {
      label: `成交量MA${period}`,
      unit: "shares",
    };
  }
  return {
    id: "market.averages",
    dataset: "market",
    provider: "sina",
    enabledBy: ["sina"],
    endpoint: new URL(url).origin + new URL(url).pathname,
    async run(signal) {
      const text = await http.getText(url, { ...(signal && { signal }) });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Sina returned invalid moving-average JSON.",
          { cause },
        );
      }
      const retrievedAt = new Date().toISOString();
      const rows = sourceArray(parsed, "moving averages")
        .map((item) => {
          const raw = sourceObject(item, "moving average");
          const date = sourceDate(raw.day);
          const values: CollectionRow["values"] = {};
          for (const period of [5, 10, 20, 30]) {
            values[`ma${period}`] = collectedNumber(
              raw[`ma_price${period}`],
              `ma_price${period}`,
            );
            values[`volumeMa${period}`] = collectedNumber(
              raw[`ma_volume${period}`],
              `ma_volume${period}`,
            );
          }
          return sourceRow(date, values, scope);
        })
        .filter((row) => row.date <= scope.date && row.complete)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-60);
      if (rows.length === 0)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          "The Sina moving-average endpoint only supplies its current rolling window, which has no observations within the requested historical cutoff.",
        );
      const data: CollectedTableData = {
        table: "market.averages",
        title: "源站日均线",
        columns,
        rows,
        currency: "CNY",
        adjustment: "unadjusted",
        interval: "1d",
      };
      const envelope = collectedEnvelope(
        scope,
        "market",
        data,
        "sina",
        url,
        retrievedAt,
      );
      envelope.gaps.push(...windowGap(data, 60), {
        code: "missing",
        field: "/data/columns/ma60",
        detail:
          "The Sina endpoint does not supply MA60 in its response; it is not calculated locally.",
      });
      return envelope;
    },
  };
}

const VALUATION_FIELDS: Record<string, CollectionColumn> = {
  PE_TTM: { label: "滚动市盈率", unit: "multiple" },
  PE_LAR: { label: "静态市盈率", unit: "multiple" },
  PB_MRQ: { label: "市净率", unit: "multiple" },
  PS_TTM: { label: "市销率", unit: "multiple" },
  PCF_OCF_TTM: { label: "滚动市现率", unit: "multiple" },
  TOTAL_MARKET_CAP: { label: "总市值", unit: "CNY" },
  NOTLIMITED_MARKETCAP_A: { label: "流通市值", unit: "CNY" },
  TOTAL_SHARES: { label: "总股本", unit: "shares" },
  FREE_SHARES_A: { label: "流通股本", unit: "shares" },
};

function valuationTask(http: HttpClient, scope: ResearchScope): CollectionTask {
  const end = completedEnd(scope, "1d");
  const code = scope.security.symbol.slice(0, 6);
  const url = urlWith("https://datacenter-web.eastmoney.com/api/data/v1/get", {
    reportName: "RPT_VALUEANALYSIS_DET",
    columns: [
      "SECURITY_CODE",
      "TRADE_DATE",
      ...Object.keys(VALUATION_FIELDS),
    ].join(","),
    filter: `(SECURITY_CODE="${code}")(TRADE_DATE<='${end}')`,
    sortColumns: "TRADE_DATE",
    sortTypes: "-1",
    pageSize: "60",
    pageNumber: "1",
  });
  return {
    id: "valuation.history",
    dataset: "fundamentals",
    provider: "eastmoney",
    enabledBy: ["eastmoney-market"],
    endpoint: new URL(url).origin + new URL(url).pathname,
    async run(signal) {
      const response = parseSourceJson(
        await http.getText(url, { ...(signal && { signal }) }),
      );
      const retrievedAt = new Date().toISOString();
      if (response.success !== true || response.code !== 0)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Eastmoney reported a valuation-data error.",
          { cause: response },
        );
      const result = sourceObject(response.result, "result");
      const rows = sourceArray(result.data, "result.data")
        .map((item) => {
          const raw = sourceObject(item, "valuation");
          if (raw.SECURITY_CODE !== code)
            sourceError("SECURITY_CODE", "security does not match the request");
          if (typeof raw.TRADE_DATE !== "string")
            sourceError("TRADE_DATE", "expected a source date");
          const date = sourceDate(raw.TRADE_DATE.slice(0, 10));
          return sourceRow(
            date,
            Object.fromEntries(
              Object.keys(VALUATION_FIELDS).map((key) => [
                key,
                collectedNumber(raw[key], key),
              ]),
            ),
            scope,
          );
        })
        .filter((row) => row.date <= end && row.complete)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-60);
      const data: CollectedTableData = {
        table: "valuation.history",
        title: "历史估值",
        columns: VALUATION_FIELDS,
        rows,
        currency: "CNY",
        basis: "source_reported",
      };
      const envelope = collectedEnvelope(
        scope,
        "fundamentals",
        data,
        "eastmoney",
        url,
        retrievedAt,
      );
      envelope.gaps.push(...windowGap(data, 60));
      return envelope;
    },
  };
}

function snapshotTasks(
  http: HttpClient,
  scope: ResearchScope,
  xueqiu?: XueqiuClient,
): CollectionTask[] {
  const code = scope.security.symbol.slice(0, 6);
  const url = urlWith("https://push2.eastmoney.com/api/qt/stock/get", {
    secid: `${scope.security.exchange === "SH" ? 1 : 0}.${code}`,
    fltt: "1",
    invt: "2",
    fields:
      "f43,f47,f48,f50,f57,f58,f59,f84,f85,f86,f116,f117,f152,f162,f163,f164,f167,f168",
  });
  const mapping = {
    price: ["f43", priceColumn("最新价"), "price"],
    volume: ["f47", { label: "成交量", unit: "shares" }, "volume"],
    amount: ["f48", { label: "成交额", unit: "CNY" }, "none"],
    volumeRatio: ["f50", { label: "量比", unit: "multiple" }, "quote"],
    peDynamic: ["f162", { label: "动态市盈率", unit: "multiple" }, "quote"],
    peStatic: ["f163", { label: "静态市盈率", unit: "multiple" }, "quote"],
    peTtm: ["f164", { label: "滚动市盈率", unit: "multiple" }, "quote"],
    pb: ["f167", { label: "市净率", unit: "multiple" }, "quote"],
    turnover: ["f168", { label: "换手率", unit: "percent" }, "quote"],
    totalShares: ["f84", { label: "总股本", unit: "shares" }, "none"],
    floatShares: ["f85", { label: "流通股本", unit: "shares" }, "none"],
    marketCap: ["f116", { label: "总市值", unit: "CNY" }, "none"],
    floatMarketCap: ["f117", { label: "流通市值", unit: "CNY" }, "none"],
  } as const;
  const columns = Object.fromEntries(
    Object.entries(mapping).map(([key, [, column]]) => [key, column]),
  );
  const task: CollectionTask = {
    id: "stock.snapshot",
    dataset: "market",
    provider: "eastmoney",
    enabledBy: ["eastmoney-market"],
    endpoint: new URL(url).origin + new URL(url).pathname,
    async run(signal) {
      const response = parseSourceJson(
        await http.getText(url, { ...(signal && { signal }) }),
      );
      const retrievedAt = new Date().toISOString();
      if (response.rc !== 0)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Eastmoney reported a quote-data error.",
          { cause: response },
        );
      const raw = sourceObject(response.data, "data");
      if (raw.f57 !== code)
        sourceError("f57", "security does not match the request");
      if (typeof raw.f58 !== "string" || raw.f58.trim() === "")
        sourceError("f58", "expected the source security name");
      if (typeof raw.f86 !== "number" || !Number.isSafeInteger(raw.f86))
        sourceError("f86", "expected Unix seconds for quote time");
      for (const key of ["f59", "f152"])
        if (
          typeof raw[key] !== "number" ||
          !Number.isInteger(raw[key]) ||
          raw[key] < 0 ||
          raw[key] > 8
        )
          sourceError(key, "expected a decimal precision");
      const asOf = new Date(raw.f86 * 1000).toISOString();
      const date = localDate.format(new Date(asOf));
      if (asOf > scope.cutoff || date > scope.date)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          "The current quote snapshot is after the research cutoff; it cannot supply a historical quote.",
        );
      const values = Object.fromEntries(
        Object.entries(mapping).map(([key, [field, , scale]]) => {
          const value = collectedNumber(raw[field], field);
          const divisor =
            scale === "price"
              ? 10 ** (raw.f59 as number)
              : scale === "quote"
                ? 10 ** (raw.f152 as number)
                : 1;
          return [
            key,
            value === null
              ? null
              : scale === "volume"
                ? value * 100
                : value / divisor,
          ];
        }),
      );
      return collectedEnvelope(
        scope,
        "market",
        {
          table: "stock.snapshot",
          title: "股票基础与最新估值快照",
          columns,
          rows: [{ date, asOf, availableAt: null, complete: true, values }],
          currency: "CNY",
          adjustment: "unadjusted",
          basis: "current_quote",
          attributes: {
            name: raw.f58,
            code,
            exchange: scope.security.exchange,
          },
        },
        "eastmoney",
        url,
        retrievedAt,
      );
    },
  };
  const candidates = [task];
  if (xueqiu !== undefined) {
    const client = xueqiu;
    candidates.push({
      id: task.id,
      dataset: "market",
      provider: "xueqiu",
      enabledBy: ["xueqiu"],
      endpoint: "https://stock.xueqiu.com/v5/stock/quote.json",
      async run(signal) {
        const symbol = scope.security.exchange + code;
        const response = await client.get(
          "/v5/stock/quote.json",
          { symbol, extend: "detail" },
          signal,
        );
        const raw = sourceObject(response.data.quote, "quote");
        if (raw.symbol !== symbol)
          sourceError("symbol", "security does not match the request");
        if (raw.currency !== "CNY")
          sourceError("currency", "expected CNY quote quantities");
        if (typeof raw.name !== "string" || raw.name.trim() === "")
          sourceError("name", "expected the source security name");
        const asOf = xueqiuTimestamp(raw.timestamp, "timestamp");
        const date = localDate.format(new Date(asOf));
        if (asOf > scope.cutoff || date > scope.date)
          throw new ResearchError(
            "DATA_INSUFFICIENT",
            "The current quote snapshot is after the research cutoff; it cannot supply a historical quote.",
          );
        const fields = {
          price: "current",
          volume: "volume",
          amount: "amount",
          volumeRatio: "volume_ratio",
          peStatic: "pe_lyr",
          peTtm: "pe_ttm",
          pb: "pb",
          turnover: "turnover_rate",
          totalShares: "total_shares",
          floatShares: "float_shares",
          marketCap: "market_capital",
          floatMarketCap: "float_market_capital",
        };
        const values: CollectionRow["values"] = {
          ...Object.fromEntries(
            Object.entries(fields).map(([key, field]) => [
              key,
              collectedNumber(raw[field], field),
            ]),
          ),
          peDynamic: null,
        };
        for (const key of ["price", "volume", "amount"])
          if (values[key] !== null && values[key]! < 0)
            sourceError(key, "expected a nonnegative quantity");
        return collectedEnvelope(
          scope,
          "market",
          {
            table: task.id,
            title: "股票基础与最新估值快照",
            columns,
            rows: [{ date, asOf, availableAt: null, complete: true, values }],
            currency: "CNY",
            adjustment: "unadjusted",
            basis: "current_quote",
            attributes: {
              name: raw.name,
              code,
              exchange: scope.security.exchange,
            },
          },
          "xueqiu",
          response.url,
          response.retrievedAt,
        );
      },
    });
  }
  return candidates;
}

export function createChinaMarketTasks(
  http: HttpClient,
  scope: ResearchScope,
  xueqiu?: XueqiuClient,
): CollectionTask[] {
  if (
    scope.security.market !== "CN" ||
    scope.security.currency !== "CNY" ||
    !["SH", "SZ"].includes(scope.security.exchange)
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "Deterministic China market collection supports SH/SZ A shares in CNY.",
    );
  const eastmoney = http.forSource("eastmoney");
  const tencent = http.forSource("tencent");
  const sina = http.forSource("sina");
  return [
    ...MARKET_WINDOWS.flatMap((window) =>
      klineTasks(eastmoney, scope, window, tencent, sina, xueqiu),
    ),
    averagesTask(sina, scope),
    valuationTask(eastmoney, scope),
    ...snapshotTasks(eastmoney, scope, xueqiu),
  ];
}
