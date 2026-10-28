import type { IndicatorResult } from "../contracts/indicators.js";
import type { EvidenceEnvelope } from "../contracts/query.js";
import type { SinaIncomeField } from "../contracts/sina-income.js";
import type { CandidateSeed } from "../contracts/task-data.js";

function indicatorLabel(series: IndicatorResult): string {
  const parameters =
    series.kind === "macd"
      ? [series.fastPeriod, series.slowPeriod, series.signalPeriod]
      : series.kind === "boll"
        ? [series.period, series.deviations]
        : [series.period];
  return `${series.kind.toUpperCase()}(${parameters.join(",")})`;
}

export function extractCandidates(envelope: EvidenceEnvelope): CandidateSeed[] {
  const data = envelope.data;
  const candidates: CandidateSeed[] = [];
  function add(
    id: string,
    label: string,
    value: number | null | undefined,
    unit: string,
    selector: string,
    asOf = envelope.asOf,
  ) {
    if (value !== null && value !== undefined)
      candidates.push({
        candidateId: id,
        label,
        value,
        unit,
        asOf,
        selector,
      });
  }
  if ("table" in data) {
    const index = data.rows.length - 1;
    const latest = data.rows.at(-1);
    if (latest === undefined) return candidates;
    for (const [field, column] of Object.entries(data.columns))
      add(
        `${data.table}.${field}`,
        `${latest.periodStart === undefined ? latest.date : `${latest.periodStart}–${latest.date}`} ${column.label}`,
        latest.values[field],
        column.unit,
        `/data/rows/${index}/values/${field}`,
        latest.asOf,
      );
  } else if ("market" in data) {
    for (const field of ["start", "end"] as const) {
      const point = data[field];
      if (point !== null)
        add(
          `returns.${field}`,
          `${point.date} ${field} close`,
          point.price,
          `${point.currency}/share`,
          `/data/${field}/price`,
          point.asOf,
        );
    }
    add(
      "returns.value",
      `${data.requestedStartDate}–${data.requestedEndDate} price return`,
      data.value,
      data.unit,
      "/data/value",
    );
  } else if ("bars" in data) {
    const index = data.bars.length - 1;
    const latest = data.bars.at(-1);
    if (latest === undefined) return candidates;
    for (const field of ["open", "high", "low", "close", "volume"] as const)
      add(
        `market.${field}`,
        `${latest.date} ${field}`,
        latest[field],
        field === "volume" ? "shares" : `${data.currency}/share`,
        `/data/bars/${index}/${field}`,
      );
    if ("indicators" in data) {
      for (const [seriesIndex, series] of data.indicators.series.entries()) {
        const latestValue = series.values.at(-1);
        if (latestValue === null || latestValue === undefined) continue;
        const values: [string, number | null][] =
          typeof latestValue === "number"
            ? [["value", latestValue]]
            : "middle" in latestValue
              ? [
                  ["middle", latestValue.middle],
                  ["upper", latestValue.upper],
                  ["lower", latestValue.lower],
                ]
              : [
                  ["macd", latestValue.macd],
                  ["signal", latestValue.signal],
                  ["histogram", latestValue.histogram],
                ];
        for (const [field, value] of values)
          add(
            `indicators.${seriesIndex}.${field}`,
            `${latest.date} ${indicatorLabel(series)} ${field}`,
            value,
            series.unit,
            `/data/indicators/series/${seriesIndex}/values/${index}${typeof latestValue === "number" ? "" : `/${field}`}`,
          );
      }
    }
  } else if ("concept" in data) {
    const index = data.observations.length - 1;
    const latest = data.observations.at(-1);
    if (latest !== undefined)
      add(
        `fundamentals.${data.field}`,
        `${data.field} ${latest.periodStart}–${latest.periodEnd} ${latest.accession}`,
        latest.value,
        data.currency,
        `/data/observations/${index}/value`,
      );
  } else if ("fields" in data) {
    const index = data.observations.length - 1;
    const latest = data.observations.at(-1);
    if (latest === undefined) return candidates;
    const values: Partial<Record<SinaIncomeField, number | null>> =
      latest.values;
    for (const field of data.fields)
      add(
        `fundamentals.${field}`,
        `${field} ${latest.periodStart}–${latest.periodEnd}`,
        values[field],
        data.currency,
        `/data/observations/${index}/values/${field}`,
      );
  } else if ("seriesId" in data) {
    const index = data.observations.length - 1;
    const latest = data.observations.at(-1);
    if (latest !== undefined)
      add(
        `macro.${data.seriesId}`,
        `${data.seriesId} ${latest.date}`,
        latest.value,
        data.unit,
        `/data/observations/${index}/value`,
      );
  }
  return candidates;
}
