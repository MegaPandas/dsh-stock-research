import type { DataEnvelope, DataGap } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  SinaIncomeData,
  SinaIncomeField,
  SinaIncomeObservation,
  SinaIncomeQuery,
} from "../contracts/sina-income.js";
import type { HttpClient } from "./http.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const FIELDS: Record<SinaIncomeField, string> = {
  revenue: "BIZINCO",
  totalOperatingRevenue: "BIZTOTINCO",
  netIncome: "NETPROFIT",
  netIncomeToParent: "PARENETP",
};
const PERIOD_ENDS = new Set(["03-31", "06-30", "09-30", "12-31"]);
const localDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const MILLISECONDS_PER_SECOND = 1000;

function compactDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{8}$/.test(value))
    sourceError("date", "expected YYYYMMDD");
  return sourceDate(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
  );
}

function updateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    sourceError("update_time", "expected integer Unix seconds or null");
  const date = new Date(value * MILLISECONDS_PER_SECOND);
  if (Number.isNaN(date.getTime()))
    sourceError("update_time", "timestamp is out of range");
  const iso = date.toISOString();
  if (!/^\d{4}-/.test(iso))
    sourceError("update_time", "expected a four-digit calendar year");
  return iso;
}

function amount(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
    sourceError(field, "expected a decimal amount string or null");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) sourceError(field, "amount is not finite");
  return parsed;
}

export class SinaIncomeAdapter {
  readonly capability = {
    provider: "sina",
    dataset: "fundamentals",
    market: "CN",
    exchanges: ["SH", "SZ"],
    currency: "CNY",
    view: "latest",
    fields: [
      "revenue",
      "totalOperatingRevenue",
      "netIncome",
      "netIncomeToParent",
    ],
    historicalVersions: false,
    ...SOURCE_VERSIONS["fundamentals/sina"],
  } as const;

  constructor(private readonly http: HttpClient) {}

  async query(
    query: SinaIncomeQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<SinaIncomeData>> {
    const security = query.scope.security;
    if (
      security.market !== "CN" ||
      security.currency !== "CNY" ||
      (security.exchange !== "SH" && security.exchange !== "SZ")
    )
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "Sina income normalization supports SH/SZ A shares in CNY.",
      );
    const url = new URL(
      "https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022",
    );
    url.search = new URLSearchParams({
      paperCode: `${security.exchange.toLowerCase()}${security.symbol.slice(0, 6)}`,
      source: "lrb",
      type: "0",
      page: "1",
      num: "1",
    }).toString();
    const text = await this.http.getText(url, { ...(signal && { signal }) });
    const retrievedAt = new Date().toISOString();
    const response = parseSourceJson(text);
    const result = sourceObject(response.result, "result");
    if (sourceObject(result.status, "status").code !== 0)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "Sina reported an income-data error.",
        { cause: response },
      );
    const data = sourceObject(result.data, "data");
    const dates = sourceArray(data.report_date, "report_date");
    const reports = sourceObject(data.report_list, "report_list");
    if (dates.length === 0 && Object.keys(reports).length === 0)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "Sina returned no income report.",
      );
    if (dates.length !== 1 || Object.keys(reports).length !== 1)
      sourceError("report_list", "expected exactly one requested report");
    const dateKey = sourceObject(dates[0], "report_date[0]").date_value;
    const periodEnd = compactDate(dateKey);
    if (!PERIOD_ENDS.has(periodEnd.slice(5)))
      sourceError("report_date", "expected a quarter or year end");
    const report = sourceObject(
      reports[periodEnd.replaceAll("-", "")],
      "report_list[date_value]",
    );
    if (report.rCurrency !== "CNY" || report.rType !== "合并期末")
      sourceError("report", "expected a consolidated CNY report");
    const publishDate =
      report.publish_date === null || report.publish_date === undefined
        ? null
        : compactDate(report.publish_date);
    if (publishDate !== null && publishDate < periodEnd)
      sourceError(
        "publish_date",
        "publication precedes the observation period end",
      );
    const sourceUpdatedAt = updateTime(report.update_time);
    const asOf = `${periodEnd}T15:59:59.999Z`;
    const cutoffDate = localDateFormatter.format(
      Date.parse(query.scope.cutoff),
    );
    if (
      periodEnd > query.scope.date ||
      asOf > query.scope.cutoff ||
      (publishDate !== null && publishDate > cutoffDate) ||
      (sourceUpdatedAt !== null && sourceUpdatedAt > query.scope.cutoff)
    )
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "The latest Sina report is beyond cutoff; historical pages are not fetched.",
      );

    const selected = new Map(
      query.fields.map((field) => [FIELDS[field], field]),
    );
    const values: SinaIncomeObservation["values"] = {};
    for (const item of sourceArray(report.data, "report.data")) {
      const row = sourceObject(item, "item");
      if (typeof row.item_field !== "string")
        sourceError("item_field", "expected a field identifier");
      const field = selected.get(row.item_field);
      if (field === undefined) continue;
      if (Object.hasOwn(values, field))
        sourceError(row.item_field, "duplicate requested field");
      values[field] = amount(row.item_value, row.item_field);
    }
    const gaps: DataGap[] = [
      {
        code: "unverified_time",
        field: "/data/observations/0",
        detail:
          "Sina supplies the latest report view. Publication dates and update timestamps do not establish the historical values or exact public availability at cutoff.",
      },
    ];
    for (const field of query.fields) {
      if (values[field] === undefined) values[field] = null;
      if (values[field] === null)
        gaps.push({
          code: "missing",
          field: `/data/observations/0/values/${field}`,
          detail: `${FIELDS[field]} is absent in the report.`,
        });
    }
    if (publishDate === null)
      gaps.push({
        code: "missing",
        field: "/data/observations/0/publishDate",
        detail: "The source provides no publication date.",
      });
    if (sourceUpdatedAt === null)
      gaps.push({
        code: "missing",
        field: "/data/observations/0/sourceUpdatedAt",
        detail: "The source provides no update timestamp.",
      });
    const ageMs = Date.parse(query.scope.cutoff) - Date.parse(asOf);
    const stale = ageMs > query.maxAgeMs;
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
        consolidation: "consolidated",
        fields: [...query.fields],
        observations: [
          {
            periodStart: `${periodEnd.slice(0, 4)}-01-01`,
            periodEnd,
            publishDate,
            sourceUpdatedAt,
            values,
            availableAt: null,
          },
        ],
      },
      source: {
        provider: "sina",
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
