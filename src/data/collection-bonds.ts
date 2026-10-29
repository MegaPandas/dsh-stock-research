import type { CollectionRow, CollectionTask } from "../contracts/collection.js";
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

const OBSERVATION_COUNT = 60;
const SOURCE_FIELDS = {
  china10y: "EMM00166466",
  us10y: "EMG00001310",
} as const;

/** Both benchmarks are source-reported yields in one dated table, never bond prices or returns. */
export function createBenchmarkBondTasks(
  http: HttpClient,
  scope: ResearchScope,
): CollectionTask[] {
  const cutoffDate = scope.cutoff.slice(0, 10);
  const end = scope.date < cutoffDate ? scope.date : cutoffDate;
  const url = new URL("https://datacenter.eastmoney.com/api/data/get");
  url.search = new URLSearchParams({
    type: "RPTA_WEB_TREASURYYIELD",
    sty: "ALL",
    st: "SOLAR_DATE",
    sr: "-1",
    p: "1",
    ps: String(OBSERVATION_COUNT),
    filter: `(SOLAR_DATE<='${end}')`,
  }).toString();
  return [
    {
      id: "benchmark.bondYields",
      dataset: "macro",
      provider: "eastmoney",
      enabledBy: ["benchmarks"],
      endpoint: url.origin + url.pathname,
      async run(signal) {
        const response = parseSourceJson(
          await http.getText(url, { ...(signal && { signal }) }),
        );
        const retrievedAt = new Date().toISOString();
        if (response.success !== true || response.code !== 0)
          throw new ResearchError(
            "SOURCE_UNAVAILABLE",
            "Eastmoney benchmark bond-yield query failed.",
            { cause: response },
          );
        const result = sourceObject(response.result, "result");
        const rows: CollectionRow[] = sourceArray(result.data, "result.data")
          .map((value) => {
            const item = sourceObject(value, "bond yield observation");
            if (
              typeof item.SOLAR_DATE !== "string" ||
              !/^\d{4}-\d{2}-\d{2}(?: 00:00:00)?$/.test(item.SOLAR_DATE)
            )
              sourceError(
                "SOLAR_DATE",
                "expected a source calendar-date label",
              );
            const date = sourceDate(item.SOLAR_DATE.slice(0, 10));
            return {
              date,
              asOf: `${date}T00:00:00.000Z`,
              availableAt: null,
              complete: true,
              values: Object.fromEntries(
                Object.entries(SOURCE_FIELDS).map(([key, field]) => [
                  key,
                  collectedNumber(item[field], field),
                ]),
              ),
            };
          })
          .filter((row) => row.date <= end && row.asOf <= scope.cutoff)
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-OBSERVATION_COUNT);
        const envelope = collectedEnvelope(
          scope,
          "macro",
          {
            table: "benchmark.bondYields",
            title: "中美10年期国债收益率",
            columns: {
              china10y: { label: "中国10年期国债收益率", unit: "percent" },
              us10y: { label: "美国10年期国债收益率", unit: "percent" },
            },
            rows,
            interval: "1d",
            basis: "source_reported_daily_yield",
          },
          "eastmoney",
          url.href,
          retrievedAt,
        );
        if (rows.length < OBSERVATION_COUNT)
          envelope.gaps.push({
            code: "missing",
            field: "/data/rows",
            detail: `The source returned ${rows.length} dated observations; the fixed window requests ${OBSERVATION_COUNT}. Country-specific missing yields remain null.`,
          });
        return envelope;
      },
    },
  ];
}
