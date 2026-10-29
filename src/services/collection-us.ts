import type {
  CollectedTableData,
  CollectionTask,
} from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import type { QueryRequest } from "../contracts/query.js";
import type { CollectionOptions } from "../contracts/collection.js";
import type { QueryService } from "./query.js";
import { COLLECTION_VERSION } from "../data/versions.js";
import { SESSION_DATES } from "../data/market-session.js";

/** US collection retains the explicitly configured Yahoo/SEC/FRED coverage. */
export function createUsCollectionTasks(
  queries: Pick<QueryService, "query">,
  scope: ResearchScope,
  options: CollectionOptions,
): CollectionTask[] {
  const enabled = new Set(options.enabledSources);
  const dateBefore = (days: number) =>
    new Date(Date.parse(`${scope.date}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const jobs: { id: string; request: QueryRequest }[] = [];
  if (enabled.has("yahoo"))
    jobs.push({
      id: "market.daily",
      request: {
        dataset: "market",
        provider: "yahoo",
        parameters: {
          startDate:
            dateBefore(120) < SESSION_DATES.start
              ? SESSION_DATES.start
              : dateBefore(120),
          maxAgeMs: options.freshness.market,
        },
      },
    });
  const cik = options.secCiks[scope.security.id];
  if (enabled.has("sec") && cik !== undefined)
    for (const field of ["revenue", "netIncome"] as const)
      jobs.push({
        id: `financial.${field}`,
        request: {
          dataset: "fundamentals",
          provider: "sec",
          parameters: {
            cik,
            field,
            periodEndFrom: dateBefore(1096),
            maxAgeMs: options.freshness.fundamentals,
          },
        },
      });
  if (enabled.has("fred"))
    for (const seriesId of ["DGS10", "FEDFUNDS", "CPIAUCSL"] as const)
      jobs.push({
        id: `macro.${seriesId}`,
        request: {
          dataset: "macro",
          provider: "fred",
          parameters: {
            seriesId,
            startDate: dateBefore(seriesId === "DGS10" ? 90 : 1096),
            endDate: scope.date,
            maxAgeMs: options.freshness.macro,
          },
        },
      });
  return jobs.map(({ id, request }): CollectionTask => ({
    id,
    dataset: request.dataset as CollectionTask["dataset"],
    provider: request.provider,
    enabledBy: [request.provider],
    async run(signal) {
      const envelope = await queries.query(scope, request, signal);
      const source = envelope.data;
      let data: CollectedTableData;
      if ("bars" in source)
        data = {
          table: id,
          title: "美股日线",
          currency: source.currency,
          adjustment: source.adjustment,
          interval: "1d",
          columns: Object.fromEntries(
            ["open", "high", "low", "close", "volume"].map((key) => [
              key,
              {
                label: key,
                unit: key === "volume" ? "shares" : `${source.currency}/share`,
                ...(key === "volume" ? {} : { price: true }),
              },
            ]),
          ),
          rows: source.bars.slice(-60).map((bar) => ({
            date: bar.date,
            asOf: bar.asOf,
            availableAt: bar.availableAt,
            complete: bar.sessionComplete,
            values: {
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            },
          })),
        };
      else if ("concept" in source) {
        const selected = new Map(
          source.observations.map((point) => [
            `${point.periodStart}/${point.periodEnd}`,
            point,
          ]),
        );
        const ends = new Set(
          [
            ...new Set(source.observations.map((point) => point.periodEnd)),
          ].slice(-12),
        );
        data = {
          table: id,
          title: `SEC ${source.field}`,
          currency: source.currency,
          basis: "source_reported_period",
          columns: {
            [source.field]: { label: source.field, unit: source.currency },
          },
          rows: [...selected.values()]
            .filter((point) => ends.has(point.periodEnd))
            .map((point) => ({
              date: point.periodEnd,
              periodStart: point.periodStart,
              publishedDate: point.filed,
              filing: {
                accession: point.accession,
                form: point.form,
                url: point.filingUrl,
              },
              asOf: `${point.periodEnd}T23:59:59.999Z`,
              availableAt: point.availableAt,
              complete: true,
              values: { [source.field]: point.value },
            })),
        };
      } else if ("seriesId" in source)
        data = {
          table: id,
          title: source.seriesId,
          columns: { value: { label: source.seriesId, unit: source.unit } },
          rows: source.observations.slice(-36).map((point) => ({
            date: point.date,
            asOf: `${point.date}T00:00:00.000Z`,
            availableAt: point.availableAt,
            complete: true,
            values: { value: point.value },
          })),
        };
      else
        throw new Error("Unexpected data in the fixed US collection recipe.");
      return {
        ...envelope,
        data,
        source: {
          ...envelope.source,
          adapterVersion: COLLECTION_VERSION,
          normalizationVersion: COLLECTION_VERSION,
        },
        gaps: [
          ...envelope.gaps.map((gap) => ({ ...gap, field: "/data/rows" })),
          {
            code: "unverified_time",
            field: "/data/rows",
            detail:
              "The configured US source does not establish point-in-time historical revisions.",
          },
        ],
      } as DataEnvelope<CollectedTableData>;
    },
  }));
}
