import {
  STATEMENT_FIELDS,
  statementColumns,
} from "./financial-statement-fields.js";
import type {
  CollectionColumn,
  CollectionRow,
  CollectionTask,
} from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { type XueqiuClient, xueqiuDate } from "./xueqiu.js";
import { collectedEnvelope, collectedNumber } from "./collection-utils.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const REPORT_WINDOW = 12;
const QUARTER_ENDS = new Set(["03-31", "06-30", "09-30", "12-31"]);
const localDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const amount = (label: string): CollectionColumn => ({ label, unit: "CNY" });
const perShare = (label: string): CollectionColumn => ({
  label,
  unit: "CNY/share",
});
const percent = (label: string): CollectionColumn => ({
  label,
  unit: "percent",
});
const ratio = (label: string): CollectionColumn => ({ label, unit: "ratio" });
const INDICATORS: Record<string, CollectionColumn> = {
  EPSJB: perShare("基本每股收益"),
  EPSKCJB: perShare("扣非每股收益"),
  EPSXS: perShare("稀释每股收益"),
  BPS: perShare("每股净资产"),
  MGZBGJ: perShare("每股资本公积"),
  MGWFPLR: perShare("每股未分配利润"),
  MGJYXJJE: perShare("每股经营现金流"),
  TOTALOPERATEREVE: amount("营业总收入"),
  MLR: amount("毛利润"),
  PARENTNETPROFIT: amount("归母净利润"),
  KCFJCXSYJLR: amount("扣非归母净利润"),
  TOTALOPERATEREVETZ: percent("营业总收入同比"),
  PARENTNETPROFITTZ: percent("归母净利润同比"),
  KCFJCXSYJLRTZ: percent("扣非归母净利润同比"),
  ROEJQ: percent("加权净资产收益率"),
  ROEKCJQ: percent("扣非加权净资产收益率"),
  ZZCJLL: percent("总资产收益率"),
  XSJLL: percent("净利率"),
  XSMLL: percent("毛利率"),
  LD: ratio("流动比率"),
  SD: ratio("速动比率"),
  XJLLB: ratio("现金流量比率"),
  ZCFZL: percent("资产负债率"),
  CHZZTS: { label: "存货周转天数", unit: "days" },
  YSZKZZTS: { label: "应收账款周转天数", unit: "days" },
  TOAZZL: { label: "总资产周转率", unit: "multiple" },
  CHZZL: { label: "存货周转率", unit: "multiple" },
  YSZKZZL: { label: "应收账款周转率", unit: "multiple" },
};
const QUARTER: Record<string, CollectionColumn> = {
  EPSJB: perShare("单季度基本每股收益"),
  BPS: perShare("每股净资产"),
  PER_NETCASH: perShare("单季度每股经营现金流"),
  TOTALOPERATEREVE: amount("单季度营业总收入"),
  GROSS_PROFIT: amount("单季度毛利润"),
  PARENTNETPROFIT: amount("单季度归母净利润"),
  DEDU_PARENT_PROFIT: amount("单季度扣非归母净利润"),
  TOTALOPERATEREVETZ: percent("单季度营业总收入同比"),
  PARENTNETPROFITTZ: percent("单季度归母净利润同比"),
  DPNP_YOY_RATIO: percent("单季度扣非归母净利润同比"),
  ROE_DILUTED: percent("单季度摊薄净资产收益率"),
  JROA: percent("单季度总资产收益率"),
  GROSS_PROFIT_RATIO: percent("单季度毛利率"),
  NET_PROFIT_RATIO: percent("单季度净利率"),
};

interface Report {
  id: string;
  title: string;
  report: string;
  columns: Record<string, CollectionColumn>;
  basis: "year_to_date" | "single_quarter" | "point_in_time";
  notice: boolean;
  main?: boolean;
}
const REPORTS: Report[] = [
  {
    id: "financial.indicators",
    title: "历史财务指标",
    report: "RPT_F10_FINANCE_MAINFINADATA",
    columns: INDICATORS,
    basis: "year_to_date",
    notice: true,
    main: true,
  },
  {
    id: "financial.quarter",
    title: "单季度财务指标",
    report: "RPT_F10_QTR_MAINFINADATA",
    columns: QUARTER,
    basis: "single_quarter",
    notice: false,
  },
  {
    id: "financial.income",
    title: "利润表明细",
    report: "RPT_F10_FINANCE_GINCOME",
    columns: statementColumns("financial.income"),
    basis: "year_to_date",
    notice: true,
  },
  {
    id: "financial.balance",
    title: "资产负债表明细",
    report: "RPT_F10_FINANCE_GBALANCE",
    columns: statementColumns("financial.balance"),
    basis: "point_in_time",
    notice: true,
  },
  {
    id: "financial.cashflow",
    title: "现金流量表明细",
    report: "RPT_F10_FINANCE_GCASHFLOW",
    columns: statementColumns("financial.cashflow"),
    basis: "year_to_date",
    notice: true,
  },
];

const XUEQIU_REPORTS: Record<
  string,
  { endpoint: string; fields: Record<string, string> }
> = {
  "financial.indicators": {
    endpoint: "indicator",
    fields: {
      EPSJB: "basic_eps",
      BPS: "np_per_share",
      MGZBGJ: "capital_reserve",
      MGWFPLR: "undistri_profit_ps",
      MGJYXJJE: "operate_cash_flow_ps",
      TOTALOPERATEREVE: "total_revenue",
      PARENTNETPROFIT: "net_profit_atsopc",
      KCFJCXSYJLR: "net_profit_after_nrgal_atsolc",
      PARENTNETPROFITTZ: "net_profit_atsopc_yoy",
      KCFJCXSYJLRTZ: "np_atsopc_nrgal_yoy",
      ROEJQ: "avg_roe",
      XSJLL: "net_selling_rate",
      XSMLL: "gross_selling_rate",
      LD: "current_ratio",
      SD: "quick_ratio",
      ZCFZL: "asset_liab_ratio",
      CHZZTS: "inventory_turnover_days",
      YSZKZZTS: "receivable_turnover_days",
      TOAZZL: "total_capital_turnover",
      CHZZL: "inventory_turnover",
      YSZKZZL: "account_receivable_turnover",
    },
  },
  ...Object.fromEntries(
    Object.entries(STATEMENT_FIELDS).map(([id, fields]) => [
      id,
      {
        endpoint: id === "financial.cashflow" ? "cash_flow" : id.split(".")[1]!,
        fields: Object.fromEntries(
          Object.entries(fields).flatMap(([key, field]) =>
            field.xueqiu === undefined ? [] : [[key, field.xueqiu]],
          ),
        ),
      },
    ]),
  ),
};

function xueqiuValue(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const pair = sourceArray(value, field);
  if (pair.length !== 2)
    sourceError(field, "expected a source value and comparison pair");
  return collectedNumber(pair[0], field);
}

function scaledXueqiuValue(
  value: unknown,
  field: string,
  scale: number,
): number | null {
  const number = xueqiuValue(value, field);
  return number === null ? null : number * scale;
}

function xueqiuReportTask(
  client: XueqiuClient,
  scope: ResearchScope,
  report: Report,
  source: (typeof XUEQIU_REPORTS)[string],
): CollectionTask {
  const path = `/v5/stock/finance/cn/${source.endpoint}.json`;
  const cutoffDate = localDate.format(new Date(scope.cutoff));
  const end = scope.date < cutoffDate ? scope.date : cutoffDate;
  return {
    id: report.id,
    dataset: "fundamentals",
    provider: "xueqiu",
    endpoint: `https://stock.xueqiu.com${path}`,
    async run(signal) {
      const response = await client.get(
        path,
        {
          symbol: scope.security.exchange + scope.security.symbol.slice(0, 6),
          type: "all",
          is_detail: "true",
          count: String(REPORT_WINDOW),
          timestamp: String(Date.parse(scope.cutoff)),
        },
        signal,
      );
      if (response.data.currency !== "CNY")
        sourceError("currency", "expected CNY financial quantities");
      const rows: CollectionRow[] = [];
      for (const item of sourceArray(response.data.list, "list")) {
        const raw = sourceObject(item, report.id);
        const date = xueqiuDate(raw.report_date, "report_date");
        if (!QUARTER_ENDS.has(date.slice(5)))
          sourceError("report_date", "expected a quarter or year end");
        const asOf = `${date}T15:59:59.999Z`;
        if (date > end || asOf > scope.cutoff) continue;
        rows.push({
          date,
          asOf,
          availableAt: null,
          complete: true,
          publishedDate: null,
          periodStart: periodStart(date, report.basis),
          values: Object.fromEntries(
            Object.keys(report.columns).map((key) => {
              const field = source.fields[key];
              return [
                key,
                field === undefined
                  ? null
                  : scaledXueqiuValue(
                      raw[field],
                      field,
                      STATEMENT_FIELDS[report.id]?.[key]?.xueqiuScale ?? 1,
                    ),
              ];
            }),
          ),
        });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const envelope = collectedEnvelope(
        scope,
        "fundamentals",
        {
          table: report.id,
          title: report.title,
          columns: report.columns,
          rows: rows.slice(-REPORT_WINDOW),
          currency: "CNY",
          basis: report.basis,
        },
        "xueqiu",
        response.url,
        response.retrievedAt,
      );
      if (envelope.data.rows.length < REPORT_WINDOW)
        envelope.gaps.push({
          code: "missing",
          field: "/data/rows",
          detail: `The source supplies ${envelope.data.rows.length} eligible reporting periods; the fixed window requests ${REPORT_WINDOW}.`,
        });
      const absentFields = Object.entries(STATEMENT_FIELDS[report.id] ?? {})
        .filter(([, field]) => field.xueqiu === undefined)
        .map(([key]) => key);
      if (absentFields.length > 0)
        envelope.gaps.push({
          code: "missing",
          field: "/data/columns",
          detail: `Xueqiu detail does not supply these declared fields: ${absentFields.join(", ")}. Values remain null.`,
        });
      envelope.gaps.push({
        code: "unverified_time",
        field: "/data/rows/publishedDate",
        detail:
          "Xueqiu report dates and creation timestamps do not establish public disclosure times or historical revisions.",
      });
      return envelope;
    },
  };
}

function reportDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(value))
    sourceError(field, "expected a calendar date with midnight padding");
  return sourceDate(value.slice(0, 10));
}

function periodStart(date: string, basis: Report["basis"]): string {
  if (basis === "point_in_time") return date;
  if (basis === "year_to_date") return `${date.slice(0, 4)}-01-01`;
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-${String(month - 2).padStart(2, "0")}-01`;
}

function reportTask(
  http: HttpClient,
  scope: ResearchScope,
  report: Report,
): CollectionTask {
  const cutoffDate = localDate.format(new Date(scope.cutoff));
  const end = scope.date < cutoffDate ? scope.date : cutoffDate;
  const filter = `(SECUCODE="${scope.security.symbol}")(REPORT_DATE<='${end}')${report.notice ? `(NOTICE_DATE<='${end}')` : ""}`;
  const url = new URL(
    report.main
      ? "https://datacenter.eastmoney.com/securities/api/data/get"
      : "https://datacenter.eastmoney.com/securities/api/data/v1/get",
  );
  url.search = new URLSearchParams(
    report.main
      ? {
          type: report.report,
          sty: "APP_F10_MAINFINADATA",
          quoteColumns: "",
          filter,
          p: "1",
          ps: String(REPORT_WINDOW),
          sr: "-1",
          st: "REPORT_DATE",
          source: "HSF10",
          client: "PC",
        }
      : {
          reportName: report.report,
          columns: [
            "SECUCODE",
            "REPORT_DATE",
            ...(report.notice ? ["NOTICE_DATE"] : []),
            ...Object.keys(report.columns).filter(
              (key) => STATEMENT_FIELDS[report.id]?.[key]?.eastmoney !== false,
            ),
          ].join(","),
          filter,
          pageNumber: "1",
          pageSize: String(REPORT_WINDOW),
          sortColumns: "REPORT_DATE",
          sortTypes: "-1",
          source: "HSF10",
          client: "PC",
        },
  ).toString();
  return {
    id: report.id,
    dataset: "fundamentals",
    provider: "eastmoney",
    endpoint: url.origin + url.pathname,
    async run(signal) {
      const response = parseSourceJson(
        await http.getText(url, { ...(signal && { signal }) }),
      );
      const retrievedAt = new Date().toISOString();
      if (response.success !== true || response.code !== 0)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          `Eastmoney reported a ${report.title} error.`,
          { cause: response },
        );
      const result = sourceObject(response.result, "result");
      const rawRows = sourceArray(result.data, "result.data");
      const rows: CollectionRow[] = [];
      for (const item of rawRows) {
        const raw = sourceObject(item, report.id);
        if (raw.SECUCODE !== scope.security.symbol)
          sourceError("SECUCODE", "security does not match the request");
        if (
          raw.CURRENCY !== undefined &&
          raw.CURRENCY !== null &&
          raw.CURRENCY !== "CNY" &&
          raw.CURRENCY !== "人民币"
        )
          sourceError("CURRENCY", "expected CNY financial quantities");
        const date = reportDate(raw.REPORT_DATE, "REPORT_DATE");
        if (!QUARTER_ENDS.has(date.slice(5)))
          sourceError("REPORT_DATE", "expected a quarter or year end");
        const noticeDate =
          raw.NOTICE_DATE === null || raw.NOTICE_DATE === undefined
            ? null
            : reportDate(raw.NOTICE_DATE, "NOTICE_DATE");
        if (noticeDate !== null && noticeDate < date)
          sourceError("NOTICE_DATE", "notice precedes the reporting period");
        const asOf = `${date}T15:59:59.999Z`;
        if (
          date > end ||
          asOf > scope.cutoff ||
          (noticeDate !== null && noticeDate > end)
        )
          continue;
        const values = Object.fromEntries(
          Object.keys(report.columns).map((key) => [
            key,
            STATEMENT_FIELDS[report.id]?.[key]?.eastmoney === false
              ? null
              : collectedNumber(raw[key], key),
          ]),
        );
        const row = {
          date,
          asOf,
          availableAt: null,
          complete: true,
          values,
          publishedDate: noticeDate,
          periodStart: periodStart(date, report.basis),
        };
        rows.push(row);
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const envelope = collectedEnvelope(
        scope,
        "fundamentals",
        {
          table: report.id,
          title: report.title,
          columns: report.columns,
          rows: rows.slice(-REPORT_WINDOW),
          currency: "CNY",
          basis: report.basis,
        },
        "eastmoney",
        url.href,
        retrievedAt,
      );
      if (envelope.data.rows.length < REPORT_WINDOW)
        envelope.gaps.push({
          code: "missing",
          field: "/data/rows",
          detail: `The source supplies ${envelope.data.rows.length} eligible reporting periods; the fixed window requests ${REPORT_WINDOW}.`,
        });
      if (
        !report.notice ||
        rows.some(
          (row) => !("publishedDate" in row) || row.publishedDate === null,
        )
      )
        envelope.gaps.push({
          code: "unverified_time",
          field: "/data/rows/publishedDate",
          detail:
            "A source publication date is absent for one or more reporting periods; exact public availability is not established.",
        });
      return envelope;
    },
  };
}

export function createChinaFinancialTasks(
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
      "Deterministic China financial collection supports SH/SZ A shares in CNY.",
    );
  return REPORTS.map((report) => {
    const task = reportTask(http, scope, report);
    const source = XUEQIU_REPORTS[report.id];
    if (xueqiu !== undefined && source !== undefined)
      task.fallback = xueqiuReportTask(xueqiu, scope, report, source);
    return task;
  });
}
