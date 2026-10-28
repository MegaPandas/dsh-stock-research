import type { DataEnvelope, DataGap } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  FredQuery,
  MacroData,
  MacroObservation,
} from "../contracts/macro.js";
import type { HttpClient } from "./http.js";
import { sourceDate, sourceError } from "./source.js";
import { SOURCE_VERSIONS } from "./versions.js";

const SERIES = {
  DGS10: {
    unit: "percent",
    frequency: "daily",
    seasonalAdjustment: "not_seasonally_adjusted",
  },
  FEDFUNDS: {
    unit: "percent",
    frequency: "monthly",
    seasonalAdjustment: "not_seasonally_adjusted",
  },
  CPIAUCSL: {
    unit: "index_1982_1984_100",
    frequency: "monthly",
    seasonalAdjustment: "seasonally_adjusted",
  },
} as const;

export class FredCsvAdapter {
  readonly capability = {
    provider: "fred",
    dataset: "macro",
    series: SERIES,
    historicalVersions: false,
    ...SOURCE_VERSIONS["macro/fred"],
  } as const;

  constructor(private readonly http: HttpClient) {}

  async query(
    query: FredQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<MacroData>> {
    const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
    url.search = new URLSearchParams({
      id: query.seriesId,
      cosd: query.startDate,
      coed: query.endDate,
    }).toString();
    const text = await this.http.getText(url, { ...(signal && { signal }) });
    const retrievedAt = new Date().toISOString();
    const lines = text.split(/\r?\n/);
    while (lines.at(-1) === "") lines.pop();
    if (lines[0] !== `observation_date,${query.seriesId}`)
      sourceError("header", "expected the requested untransformed FRED series");
    const observations: MacroObservation[] = [];
    const dates = new Set<string>();
    for (const line of lines.slice(1)) {
      const fields = line.split(",");
      if (fields.length !== 2) sourceError("row", "expected date and value");
      const date = sourceDate(fields[0]);
      const asOf = `${date}T00:00:00.000Z`;
      if (
        date < query.startDate ||
        date > query.endDate ||
        date > query.scope.date ||
        asOf > query.scope.cutoff
      )
        continue;
      if (dates.has(date)) sourceError("date", "duplicate observation date");
      dates.add(date);
      const raw = fields[1]!;
      let value: number | null = null;
      if (raw !== "") {
        if (!/^-?\d+(?:\.\d+)?$/.test(raw))
          sourceError("value", "expected a decimal value or an empty cell");
        value = Number(raw);
        if (!Number.isFinite(value))
          sourceError("value", "value is not finite");
      }
      observations.push({ date, value, availableAt: null });
    }
    observations.sort((left, right) => left.date.localeCompare(right.date));
    const latest = observations.at(-1);
    if (latest === undefined)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "No FRED observations within the requested range and cutoff.",
      );
    const asOf = `${latest.date}T00:00:00.000Z`;
    const ageMs = Date.parse(query.scope.cutoff) - Date.parse(asOf);
    const stale = ageMs > query.maxAgeMs;
    const gaps: DataGap[] = [
      {
        code: "unverified_time",
        field: "/data/observations",
        detail:
          "FRED CSV is the current view. Observation dates are period labels, not publication times, and do not establish the vintage visible at cutoff.",
      },
    ];
    for (const [index, observation] of observations.entries()) {
      if (observation.value === null)
        gaps.push({
          code: "missing",
          field: `/data/observations/${index}/value`,
          detail: `FRED supplies no value for ${observation.date}.`,
        });
    }
    if (stale)
      gaps.push({
        code: "stale",
        field: "/data/observations",
        detail: `Latest observation date is ${ageMs} ms before cutoff; policy allows ${query.maxAgeMs} ms.`,
      });
    return {
      dataset: "macro",
      data: {
        seriesId: query.seriesId,
        ...SERIES[query.seriesId],
        view: "current",
        observations,
      },
      source: {
        provider: "fred",
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
