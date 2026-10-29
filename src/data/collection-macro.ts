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
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const MONTHS = 36;
const QUARTERS = 12;
const SOCIAL_MAX_LAG_MONTHS = 3;
const DATA_CENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const SOCIAL_URL =
  "https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery";
const amount = (label: string): CollectionColumn => ({
  label,
  unit: "CNY_100m",
});
const percent = (label: string): CollectionColumn => ({
  label,
  unit: "percent",
});
const index = (label: string): CollectionColumn => ({ label, unit: "index" });

interface MacroDefinition {
  id: string;
  title: string;
  report: string;
  columns: Record<string, CollectionColumn>;
  basis: string;
  frequency?: "quarterly" | "event";
}

const DEFINITIONS: readonly MacroDefinition[] = [
  {
    id: "macro.gdp",
    title: "中国GDP（年内累计）",
    report: "RPT_ECONOMY_GDP",
    frequency: "quarterly",
    basis: "year_to_date",
    columns: {
      DOMESTICL_PRODUCT_BASE: amount("GDP累计金额"),
      FIRST_PRODUCT_BASE: amount("第一产业累计金额"),
      SECOND_PRODUCT_BASE: amount("第二产业累计金额"),
      THIRD_PRODUCT_BASE: amount("第三产业累计金额"),
      SUM_SAME: percent("GDP累计同比"),
      FIRST_SAME: percent("第一产业累计同比"),
      SECOND_SAME: percent("第二产业累计同比"),
      THIRD_SAME: percent("第三产业累计同比"),
    },
  },
  {
    id: "macro.cpi",
    title: "中国居民消费价格指数",
    report: "RPT_ECONOMY_CPI",
    basis: "monthly; source indices use prior-year corresponding period=100",
    columns: {
      NATIONAL_SAME: percent("全国CPI同比"),
      NATIONAL_SEQUENTIAL: percent("全国CPI环比"),
      NATIONAL_BASE: index("全国CPI指数（上年同月=100）"),
      NATIONAL_ACCUMULATE: index("全国CPI累计指数（上年同期=100）"),
    },
  },
  {
    id: "macro.ppi",
    title: "中国工业生产者出厂价格指数",
    report: "RPT_ECONOMY_PPI",
    basis: "monthly; source indices use prior-year corresponding period=100",
    columns: {
      BASE: index("PPI指数（上年同月=100）"),
      BASE_SAME: percent("PPI同比"),
      BASE_ACCUMULATE: index("PPI累计指数（上年同期=100）"),
    },
  },
  {
    id: "macro.pmi",
    title: "中国采购经理指数",
    report: "RPT_ECONOMY_PMI",
    basis: "monthly",
    columns: {
      MAKE_INDEX: index("制造业PMI"),
      NMAKE_INDEX: index("非制造业商务活动指数"),
    },
  },
  {
    id: "macro.moneySupply",
    title: "中国货币供应量",
    report: "RPT_ECONOMY_CURRENCY_SUPPLY",
    basis:
      "month_end; source definitions may change over time, including the M1 statistical scope",
    columns: {
      BASIC_CURRENCY: amount("M2余额"),
      BASIC_CURRENCY_SAME: percent("M2同比"),
      CURRENCY: amount("M1余额"),
      CURRENCY_SAME: percent("M1同比"),
      FREE_CASH: amount("M0余额"),
      FREE_CASH_SAME: percent("M0同比"),
    },
  },
  {
    id: "macro.lpr",
    title: "中国贷款市场报价利率",
    report: "RPTA_WEB_RATE",
    frequency: "event",
    basis: "quoted_annual_rate",
    columns: {
      LPR1Y: percent("1年期LPR"),
      LPR5Y: percent("5年期以上LPR"),
    },
  },
  {
    id: "macro.industrial",
    title: "中国工业增加值增长",
    report: "RPT_ECONOMY_INDUS_GROW",
    basis: "monthly_and_year_to_date",
    columns: {
      BASE_SAME: percent("工业增加值当月同比"),
      BASE_ACCUMULATE: percent("工业增加值累计同比"),
    },
  },
  {
    id: "macro.retail",
    title: "中国社会消费品零售总额",
    report: "RPT_ECONOMY_TOTAL_RETAIL",
    basis: "monthly_and_year_to_date",
    columns: {
      RETAIL_TOTAL: amount("社零当月金额"),
      RETAIL_TOTAL_SAME: percent("社零当月同比"),
      RETAIL_TOTAL_SEQUENTIAL: percent("社零当月环比"),
      RETAIL_TOTAL_ACCUMULATE: amount("社零累计金额"),
      RETAIL_ACCUMULATE_SAME: percent("社零累计同比"),
    },
  },
  {
    id: "macro.investment",
    title: "中国固定资产投资",
    report: "RPT_ECONOMY_ASSET_INVEST",
    basis: "monthly_and_year_to_date",
    columns: {
      BASE: amount("固定资产投资当月金额"),
      BASE_SAME: percent("固定资产投资当月同比"),
      BASE_SEQUENTIAL: percent("固定资产投资当月环比"),
      BASE_ACCUMULATE: amount("固定资产投资累计金额"),
    },
  },
  {
    id: "macro.trade",
    title: "中国海关进出口增长",
    report: "RPT_ECONOMY_CUSTOMS",
    basis: "monthly_and_year_to_date",
    columns: {
      EXIT_BASE_SAME: percent("出口当月同比"),
      IMPORT_BASE_SAME: percent("进口当月同比"),
      EXIT_BASE_SEQUENTIAL: percent("出口当月环比"),
      IMPORT_BASE_SEQUENTIAL: percent("进口当月环比"),
      EXIT_ACCUMULATE_SAME: percent("出口累计同比"),
      IMPORT_ACCUMULATE_SAME: percent("进口累计同比"),
    },
  },
];

const SOCIAL_COLUMNS: Record<string, CollectionColumn> = {
  tiosfs: amount("社会融资规模增量"),
  rmblaon: amount("人民币贷款增量"),
  forcloan: amount("外币贷款增量（折合人民币）"),
  entrustloan: amount("委托贷款增量"),
  trustloan: amount("信托贷款增量"),
  ndbab: amount("未贴现银行承兑汇票增量"),
  bibae: amount("企业债券净融资"),
  sfinfe: amount("非金融企业境内股票融资"),
};

function monthStart(date: string, offset: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, month + offset, 1)).toISOString().slice(0, 10);
}

function windowStart(
  scope: ResearchScope,
  quarterly: boolean,
  event = false,
): string {
  if (event) return monthStart(scope.date, 1 - MONTHS);
  const length = quarterly ? 3 : 1;
  const month = Number(scope.date.slice(5, 7)) - 1;
  const start = monthStart(scope.date, quarterly ? -(month % 3) : 0);
  const end = new Date(
    Date.UTC(
      Number(start.slice(0, 4)),
      Number(start.slice(5, 7)) - 1 + length,
      0,
    ),
  )
    .toISOString()
    .slice(0, 10);
  const completed = `${end}T15:59:59.999Z` <= scope.cutoff;
  return monthStart(
    start,
    -(quarterly ? QUARTERS - 1 : MONTHS - 1) * length -
      (completed ? 0 : length),
  );
}

function reportedDate(value: unknown): string {
  if (typeof value !== "string")
    sourceError("REPORT_DATE", "expected a date string");
  return sourceDate(value.slice(0, 10));
}

function observation(
  date: string,
  row: Record<string, unknown>,
  columns: Record<string, CollectionColumn>,
  event: boolean,
): CollectionRow {
  // Monthly REPORT_DATE labels use the first day; the observation ends at month end.
  const periodEnd = event
    ? date
    : new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10);
  return {
    date,
    asOf: event ? `${date}T00:00:00.000Z` : `${periodEnd}T15:59:59.999Z`,
    availableAt: null,
    complete: true,
    values: Object.fromEntries(
      Object.keys(columns).map((key) => [key, collectedNumber(row[key], key)]),
    ),
  };
}

function eastmoneyTask(
  http: HttpClient,
  scope: ResearchScope,
  definition: MacroDefinition,
): CollectionTask {
  const dateField =
    definition.frequency === "event" ? "TRADE_DATE" : "REPORT_DATE";
  const start = windowStart(
    scope,
    definition.frequency === "quarterly",
    definition.frequency === "event",
  );
  const end =
    definition.frequency === "event"
      ? scope.date
      : new Date(
          Date.parse(`${monthStart(start, MONTHS)}T00:00:00.000Z`) - 86_400_000,
        )
          .toISOString()
          .slice(0, 10);
  const url = new URL(DATA_CENTER);
  url.search = new URLSearchParams({
    reportName: definition.report,
    columns: [dateField, ...Object.keys(definition.columns)].join(","),
    filter: `(${dateField}>='${start}')(${dateField}<='${end}')`,
    pageNumber: "1",
    pageSize: String(definition.frequency === "quarterly" ? QUARTERS : MONTHS),
    sortColumns: dateField,
    sortTypes: "-1",
  }).toString();
  return {
    id: definition.id,
    dataset: "macro",
    provider: "eastmoney",
    enabledBy: ["china-macro"],
    endpoint: DATA_CENTER,
    async run(signal) {
      const text = await http.getText(url, { ...(signal && { signal }) });
      const retrievedAt = new Date().toISOString();
      const response = parseSourceJson(text);
      if (response.success !== true)
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Eastmoney macro query failed.",
          { cause: response },
        );
      const result = sourceObject(response.result, "result");
      if (typeof result.pages !== "number" || result.pages > 1)
        sourceError(
          "result.pages",
          "the bounded macro window must fit one page",
        );
      const rows = sourceArray(result.data, "result.data").flatMap((value) => {
        const item = sourceObject(value, "observation");
        const date = reportedDate(item[dateField]);
        if (date < start || date > end) return [];
        if (
          definition.frequency === "quarterly" &&
          !["03", "06", "09", "12"].includes(date.slice(5, 7))
        )
          sourceError(dateField, "expected a quarter-ending month label");
        const point = observation(
          date,
          item,
          definition.columns,
          definition.frequency === "event",
        );
        return point.asOf <= scope.cutoff ? [point] : [];
      });
      const data: CollectedTableData = {
        table: definition.id,
        title: definition.title,
        columns: definition.columns,
        rows,
        basis: definition.basis,
      };
      return collectedEnvelope(
        scope,
        "macro",
        data,
        "eastmoney",
        url.href,
        retrievedAt,
      );
    },
  };
}

function socialFinancingTask(
  http: HttpClient,
  scope: ResearchScope,
): CollectionTask {
  return {
    id: "macro.socialFinancing",
    dataset: "macro",
    provider: "mofcom",
    enabledBy: ["china-macro"],
    endpoint: SOCIAL_URL,
    async run(signal) {
      const text = await http.postText(SOCIAL_URL, {
        ...(signal && { signal }),
      });
      const retrievedAt = new Date().toISOString();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch (cause) {
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Social financing source returned invalid JSON.",
          { cause },
        );
      }
      const start = windowStart(scope, false);
      const rows = sourceArray(response, "social financing").flatMap(
        (value) => {
          const item = sourceObject(value, "social financing observation");
          if (typeof item.date !== "string" || !/^\d{6}$/.test(item.date))
            sourceError("date", "expected YYYYMM");
          const date = sourceDate(
            `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-01`,
          );
          if (date < start || date > scope.date) return [];
          const point = observation(date, item, SOCIAL_COLUMNS, false);
          return point.asOf <= scope.cutoff ? [point] : [];
        },
      );
      const envelope = collectedEnvelope(
        scope,
        "macro",
        {
          table: "macro.socialFinancing",
          title: "中国社会融资规模增量",
          columns: SOCIAL_COLUMNS,
          rows,
          basis: "monthly_increment",
        },
        "mofcom",
        SOCIAL_URL,
        retrievedAt,
      );
      const latest = envelope.data.rows.at(-1)!.date;
      if (latest < monthStart(scope.date, -SOCIAL_MAX_LAG_MONTHS)) {
        envelope.stale = true;
        envelope.gaps.push({
          code: "stale",
          field: "/data/rows",
          detail: `The source's latest social financing period is ${latest.slice(0, 7)}, more than ${SOCIAL_MAX_LAG_MONTHS} calendar months before the research month. This is an age policy, not proof of a publication schedule.`,
        });
      }
      return envelope;
    },
  };
}

export function createChinaMacroTasks(
  http: HttpClient,
  scope: ResearchScope,
): CollectionTask[] {
  return [
    ...DEFINITIONS.map((definition) =>
      eastmoneyTask(http.forSource("eastmoney"), scope, definition),
    ),
    socialFinancingTask(http.forSource("mofcom"), scope),
  ];
}
