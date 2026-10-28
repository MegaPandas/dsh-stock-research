import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { IndicatorRequest } from "../contracts/indicators.js";
import type { PriceReturnsQuery, QueryRequest } from "../contracts/query.js";
import type { ReplayEvidenceSource } from "../contracts/replay.js";
import { parseLocalDate } from "../contracts/time.js";
import {
  invalid,
  object,
  objectSchema,
  positive,
  stringSchema,
  text,
} from "./parameters.js";

export type DataToolName =
  | "stock_get_market"
  | "stock_get_fundamentals"
  | "stock_get_macro"
  | "stock_get_returns"
  | "stock_research";
export interface QueryToolPolicy {
  freshness: { market: number; fundamentals: number; macro: number };
  secCiks: Readonly<Record<string, string>>;
}

export function captureQueryPolicy(policy: QueryToolPolicy): QueryToolPolicy {
  for (const key of ["market", "fundamentals", "macro"] as const) {
    const value = policy.freshness[key];
    if (!Number.isFinite(value) || value < 0)
      invalid("Freshness requires a finite nonnegative number.");
  }
  for (const cik of Object.values(policy.secCiks)) {
    if (
      typeof cik !== "string" ||
      !/^\d{10}$/.test(cik) ||
      cik === "0000000000"
    )
      invalid("CIK requires ten digits and must not be zero.");
  }
  return { freshness: { ...policy.freshness }, secCiks: { ...policy.secCiks } };
}

const marketProviders = ["yahoo", "eastmoney", "tencent"] as const;
const secFields = ["revenue", "netIncome"] as const;
const eastmoneyFields = ["totalOperatingRevenue", "netIncomeToParent"] as const;
const sinaFields = [
  "revenue",
  "totalOperatingRevenue",
  "netIncome",
  "netIncomeToParent",
] as const;
const seriesIds = ["DGS10", "FEDFUNDS", "CPIAUCSL"] as const;
const periodKinds = ["sma", "ema", "rsi", "atr", "vwma", "mfi"] as const;
const enumeration = (values: readonly string[]): JsonSchemaNode => ({
  type: "string",
  enum: [...values],
});
const integerSchema = { type: "integer" } as const;
const sourceSchema = objectSchema({
  runId: stringSchema,
  evidenceId: stringSchema,
});
const indicatorSchema: JsonSchemaNode = {
  oneOf: [
    objectSchema({ kind: enumeration(periodKinds), period: integerSchema }),
    objectSchema({
      kind: enumeration(["boll"]),
      period: integerSchema,
      deviations: { type: "number" },
    }),
    objectSchema({
      kind: enumeration(["macd"]),
      fastPeriod: integerSchema,
      slowPeriod: integerSchema,
      signalPeriod: integerSchema,
    }),
  ],
};
function schema(
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
) {
  return objectSchema({ ...properties, source: sourceSchema }, required);
}
const fieldsSchema = (fields: readonly string[]): JsonSchemaNode => ({
  type: "array",
  items: enumeration(fields),
});
export const dataSchemas: Record<
  DataToolName,
  JsonSchemaNode & Record<string, unknown>
> = {
  stock_get_market: schema(
    {
      provider: enumeration(marketProviders),
      startDate: stringSchema,
      indicators: { type: "array", items: indicatorSchema },
    },
    ["provider", "startDate"],
  ),
  stock_get_fundamentals: schema(
    {
      provider: enumeration(["sec", "eastmoney", "sina"]),
      field: {
        ...enumeration(secFields),
        description: "SEC必填；东财和新浪不接受。",
      },
      fields: {
        ...fieldsSchema(sinaFields),
        description:
          "东财和新浪必填；东财仅支持totalOperatingRevenue、netIncomeToParent；SEC不接受。",
      },
      periodEndFrom: {
        ...stringSchema,
        description: "SEC和东财必填；新浪不接受。",
      },
      periodEndTo: {
        ...stringSchema,
        description: "东财必填；SEC和新浪不接受。",
      },
    },
    ["provider"],
  ),
  stock_get_macro: schema({
    provider: enumeration(["fred"]),
    seriesId: enumeration(seriesIds),
    startDate: stringSchema,
    endDate: stringSchema,
  }),
  stock_get_returns: schema({
    provider: enumeration(marketProviders),
    historyStartDate: stringSchema,
    startDate: stringSchema,
    endDate: stringSchema,
  }),
  stock_research: schema({
    provider: enumeration(["dsh-web"]),
    query: stringSchema,
    maxResults: integerSchema,
  }),
};

function choice<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    invalid(`Unsupported ${field}.`);
  return value as T;
}
function fields<T extends string>(value: unknown, values: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0)
    invalid("fields requires a nonempty array.");
  return value.map((entry) => choice(entry, values, "field"));
}
function indicators(value: unknown): IndicatorRequest[] {
  if (!Array.isArray(value)) invalid("indicators requires an array.");
  return value.map((entry) => {
    const kind = (entry as { kind?: unknown } | null)?.kind;
    const item = object(
      entry,
      kind === "macd"
        ? ["kind", "fastPeriod", "slowPeriod", "signalPeriod"]
        : kind === "boll"
          ? ["kind", "period", "deviations"]
          : ["kind", "period"],
    );
    if (item.kind === "macd") {
      const fastPeriod = positive(item.fastPeriod, "fastPeriod");
      const slowPeriod = positive(item.slowPeriod, "slowPeriod");
      if (fastPeriod >= slowPeriod)
        invalid("fastPeriod must precede slowPeriod.");
      return {
        kind: "macd",
        fastPeriod,
        slowPeriod,
        signalPeriod: positive(item.signalPeriod, "signalPeriod"),
      };
    }
    if (item.kind === "boll") {
      if (
        typeof item.deviations !== "number" ||
        !Number.isFinite(item.deviations) ||
        item.deviations <= 0
      )
        invalid("deviations requires a finite positive number.");
      return {
        kind: "boll",
        period: positive(item.period, "period"),
        deviations: item.deviations,
      };
    }
    return {
      kind: choice(item.kind, periodKinds, "indicator kind"),
      period: positive(item.period, "period"),
    };
  });
}
function dates(values: unknown[], scope: ResearchScope): string[] {
  const parsed = values.map(parseLocalDate);
  for (let index = 1; index < parsed.length; index++) {
    if (parsed[index - 1]! > parsed[index]!) invalid("Dates must be ordered.");
  }
  if (parsed[parsed.length - 1]! > scope.date)
    invalid("Date exceeds the research date.");
  return parsed;
}

export function parseDataRequest(
  name: "stock_get_returns",
  value: unknown,
  scope: ResearchScope,
  policy: QueryToolPolicy,
): { request: PriceReturnsQuery; source: ReplayEvidenceSource | null };
export function parseDataRequest(
  name: DataToolName,
  value: unknown,
  scope: ResearchScope,
  policy: QueryToolPolicy,
): { request: QueryRequest; source: ReplayEvidenceSource | null };
export function parseDataRequest(
  name: DataToolName,
  value: unknown,
  scope: ResearchScope,
  policy: QueryToolPolicy,
): { request: QueryRequest; source: ReplayEvidenceSource | null } {
  const provider = (value as { provider?: unknown } | null)?.provider;
  const keys =
    name === "stock_get_fundamentals"
      ? provider === "sec"
        ? ["provider", "field", "periodEndFrom", "source"]
        : provider === "eastmoney"
          ? ["provider", "fields", "periodEndFrom", "periodEndTo", "source"]
          : ["provider", "fields", "source"]
      : Object.keys(dataSchemas[name].properties!);
  const base = object(value, keys);
  let source: ReplayEvidenceSource | null = null;
  if (base.source !== undefined) {
    const ref = object(base.source, ["runId", "evidenceId"]);
    source = {
      runId: text(ref.runId, "runId"),
      evidenceId: text(ref.evidenceId, "evidenceId"),
    };
  }
  let request: QueryRequest;
  switch (name) {
    case "stock_get_market": {
      const item = base;
      const [startDate] = dates([item.startDate], scope);
      const parameters = {
        startDate: startDate!,
        maxAgeMs: policy.freshness.market,
      };
      const provider = choice(item.provider, marketProviders, "provider");
      request =
        item.indicators === undefined
          ? { dataset: "market", provider, parameters }
          : {
              dataset: "market",
              provider,
              parameters: {
                ...parameters,
                indicators: indicators(item.indicators),
              },
            };
      break;
    }
    case "stock_get_fundamentals": {
      const provider = choice(
        base.provider,
        ["sec", "eastmoney", "sina"] as const,
        "provider",
      );
      const maxAgeMs = policy.freshness.fundamentals;
      if (provider === "sec") {
        const item = base;
        const [periodEndFrom] = dates([item.periodEndFrom], scope);
        const field = choice(item.field, secFields, "field");
        const cik = Object.hasOwn(policy.secCiks, scope.security.id)
          ? policy.secCiks[scope.security.id]
          : undefined;
        if (cik === undefined)
          throw new ResearchError(
            "DATA_INSUFFICIENT",
            `No configured SEC CIK for ${scope.security.id}.`,
          );
        request = {
          dataset: "fundamentals",
          provider,
          parameters: { cik, field, periodEndFrom: periodEndFrom!, maxAgeMs },
        };
      } else if (provider === "eastmoney") {
        const item = base;
        const [periodEndFrom, periodEndTo] = dates(
          [item.periodEndFrom, item.periodEndTo],
          scope,
        );
        request = {
          dataset: "fundamentals",
          provider,
          parameters: {
            fields: fields(item.fields, eastmoneyFields),
            periodEndFrom: periodEndFrom!,
            periodEndTo: periodEndTo!,
            maxAgeMs,
          },
        };
      } else {
        const item = base;
        request = {
          dataset: "fundamentals",
          provider,
          parameters: { fields: fields(item.fields, sinaFields), maxAgeMs },
        };
      }
      break;
    }
    case "stock_get_macro": {
      const item = base;
      const [startDate, endDate] = dates([item.startDate, item.endDate], scope);
      request = {
        dataset: "macro",
        provider: choice(item.provider, ["fred"], "provider"),
        parameters: {
          seriesId: choice(item.seriesId, seriesIds, "seriesId"),
          startDate: startDate!,
          endDate: endDate!,
          maxAgeMs: policy.freshness.macro,
        },
      };
      break;
    }
    case "stock_get_returns": {
      const item = base;
      const [historyStartDate, startDate, endDate] = dates(
        [item.historyStartDate, item.startDate, item.endDate],
        scope,
      );
      request = {
        dataset: "returns",
        provider: choice(item.provider, marketProviders, "provider"),
        parameters: {
          historyStartDate: historyStartDate!,
          startDate: startDate!,
          endDate: endDate!,
          maxAgeMs: policy.freshness.market,
          comparable: false,
        },
      };
      break;
    }
    case "stock_research": {
      const item = base;
      request = {
        dataset: "research",
        provider: choice(item.provider, ["dsh-web"], "provider"),
        parameters: {
          query: text(item.query, "query"),
          maxResults: positive(item.maxResults, "maxResults"),
        },
      };
      break;
    }
  }
  return { request, source };
}
