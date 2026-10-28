import type { DataEnvelope, DataGap } from "../contracts/data.js";
import type {
  EastmoneyIncomeData,
  EastmoneyIncomeField,
  EastmoneyIncomeObservation,
  EastmoneyIncomeQuery,
} from "../contracts/eastmoney-income.js";
import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const REPORT_NAME = "RPT_DMSK_FN_INCOME";
const COLUMNS: Record<EastmoneyIncomeField, string> = {
  totalOperatingRevenue: "TOTAL_OPERATE_INCOME",
  netIncomeToParent: "PARENT_NETPROFIT",
};
const MONTHS_PER_QUARTER = 3;
const QUARTERS_PER_YEAR = 4;
const PERIOD_ENDS = new Set(["03-31", "06-30", "09-30", "12-31"]);
const noticeDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function quarterIndex(date: string): number {
  return (
    Number(date.slice(0, 4)) * QUARTERS_PER_YEAR +
    Math.floor((Number(date.slice(5, 7)) - 1) / MONTHS_PER_QUARTER)
  );
}

function reportDate(value: unknown): string {
  // These columns contain calendar dates padded with midnight, not UTC instants.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(value))
    sourceError("date", "expected a calendar date with midnight padding");
  return sourceDate(value.slice(0, 10));
}

function periodAsOf(date: string): string {
  return `${date}T15:59:59.999Z`;
}

export class EastmoneyIncomeAdapter {
  readonly capability = {
    provider: "eastmoney",
    dataset: "fundamentals",
    market: "CN",
    exchanges: ["SH", "SZ"],
    currency: "CNY",
    fields: ["totalOperatingRevenue", "netIncomeToParent"],
    historicalVersions: false,
    ...SOURCE_VERSIONS["fundamentals/eastmoney"],
  } as const;

  constructor(private readonly http: HttpClient) {}

  async query(
    query: EastmoneyIncomeQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<EastmoneyIncomeData>> {
    const security = query.scope.security;
    if (
      security.market !== "CN" ||
      security.currency !== "CNY" ||
      (security.exchange !== "SH" && security.exchange !== "SZ")
    )
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "Eastmoney income normalization supports SH/SZ A shares in CNY.",
      );

    const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    url.search = new URLSearchParams({
      reportName: REPORT_NAME,
      columns: [
        "SECUCODE",
        "REPORT_DATE",
        "NOTICE_DATE",
        ...query.fields.map((field) => COLUMNS[field]),
      ].join(","),
      filter: `(SECUCODE="${security.symbol}")(REPORT_DATE>='${query.periodEndFrom}')(REPORT_DATE<='${query.periodEndTo}')`,
      pageSize: String(
        quarterIndex(query.periodEndTo) - quarterIndex(query.periodEndFrom) + 1,
      ),
      pageNumber: "1",
      sortColumns: "REPORT_DATE",
      sortTypes: "1",
    }).toString();
    const text = await this.http.getText(url, { ...(signal && { signal }) });
    const retrievedAt = new Date().toISOString();
    const response = parseSourceJson(text);
    if (response.success !== true || response.code !== 0)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "Eastmoney reported an income-data error.",
        { cause: response },
      );
    const result = sourceObject(response.result, "result");
    const rows = sourceArray(result.data, "result.data");
    if (
      result.count !== rows.length ||
      (result.pages !== 1 && !(result.pages === 0 && rows.length === 0))
    )
      sourceError(
        "result",
        "expected a complete single page; narrow the period range",
      );

    const cutoffDate = noticeDateFormatter.format(
      Date.parse(query.scope.cutoff),
    );
    const observations: EastmoneyIncomeObservation[] = [];
    const seenPeriods = new Set<string>();
    for (const item of rows) {
      const row = sourceObject(item, "income");
      if (row.SECUCODE !== security.symbol)
        sourceError("SECUCODE", "security does not match the request");
      const periodEnd = reportDate(row.REPORT_DATE);
      if (!PERIOD_ENDS.has(periodEnd.slice(5)))
        sourceError("REPORT_DATE", "expected a quarter or year end");
      if (seenPeriods.has(periodEnd))
        sourceError(
          "REPORT_DATE",
          "duplicate period in the current income view",
        );
      seenPeriods.add(periodEnd);
      const noticeDate =
        row.NOTICE_DATE === null || row.NOTICE_DATE === undefined
          ? null
          : reportDate(row.NOTICE_DATE);
      if (noticeDate !== null && noticeDate < periodEnd)
        sourceError(
          "NOTICE_DATE",
          "notice precedes the observation period end",
        );
      if (
        periodEnd < query.periodEndFrom ||
        periodEnd > query.periodEndTo ||
        periodEnd > query.scope.date ||
        periodAsOf(periodEnd) > query.scope.cutoff ||
        (noticeDate !== null && noticeDate > cutoffDate)
      )
        continue;
      const values: EastmoneyIncomeObservation["values"] = {};
      for (const field of query.fields) {
        const raw = row[COLUMNS[field]];
        const value = raw === undefined || raw === null ? null : raw;
        if (
          value !== null &&
          (typeof value !== "number" || !Number.isFinite(value))
        )
          sourceError(COLUMNS[field], "expected a finite amount or null");
        values[field] = value;
      }
      observations.push({
        periodStart: `${periodEnd.slice(0, 4)}-01-01`,
        periodEnd,
        noticeDate,
        values,
        availableAt: null,
      });
    }
    observations.sort((left, right) =>
      left.periodEnd.localeCompare(right.periodEnd),
    );
    const latest = observations.at(-1);
    if (latest === undefined)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "No income records within the requested periods and notice-date cutoff.",
      );

    const asOf = periodAsOf(latest.periodEnd);
    const ageMs = Date.parse(query.scope.cutoff) - Date.parse(asOf);
    const stale = ageMs > query.maxAgeMs;
    const gaps: DataGap[] = [
      {
        code: "unverified_time",
        field: "/data/observations",
        detail:
          "Eastmoney income is a current view. Notice dates do not establish publication times or the historical version visible at cutoff.",
      },
    ];
    for (const [index, observation] of observations.entries()) {
      if (observation.noticeDate === null)
        gaps.push({
          code: "missing",
          field: `/data/observations/${index}/noticeDate`,
          detail: "The source provides no notice date.",
        });
      for (const field of query.fields) {
        if (observation.values[field] === null)
          gaps.push({
            code: "missing",
            field: `/data/observations/${index}/values/${field}`,
            detail: `${COLUMNS[field]} is absent for ${observation.periodEnd}.`,
          });
      }
    }
    if (stale)
      gaps.push({
        code: "stale",
        field: "/data/observations",
        detail: `Latest period ended ${ageMs} ms before cutoff; policy allows ${query.maxAgeMs} ms.`,
      });

    return {
      dataset: "fundamentals",
      data: {
        currency: "CNY",
        basis: "year_to_date",
        fields: [...query.fields],
        observations,
      },
      source: {
        provider: "eastmoney",
        url: url.href,
        adapterVersion: this.capability.adapterVersion,
        normalizationVersion: this.capability.normalizationVersion,
      },
      asOf,
      availableAt: null,
      retrievedAt,
      cutoff: query.scope.cutoff,
      ageMs,
      stale,
      historicalKnowledge: "unverified",
      gaps,
    };
  }
}
