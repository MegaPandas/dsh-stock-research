import type { DataEnvelope, DataGap } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  FundamentalField,
  FundamentalObservation,
  FundamentalsData,
  SecConceptQuery,
} from "../contracts/fundamentals.js";
import type { HttpClient } from "./http.js";
import { SOURCE_VERSIONS } from "./versions.js";
import {
  parseSourceJson,
  sourceArray,
  sourceDate,
  sourceError,
  sourceObject,
} from "./source.js";

const CONCEPTS: Record<FundamentalField, string> = {
  revenue: "RevenueFromContractWithCustomerExcludingAssessedTax",
  netIncome: "NetIncomeLoss",
};
const filedDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export class SecConceptAdapter {
  readonly capability = {
    provider: "sec",
    dataset: "fundamentals",
    market: "US",
    currency: "USD",
    fields: ["revenue", "netIncome"],
    historicalVersions: false,
    ...SOURCE_VERSIONS["fundamentals/sec"],
  } as const;
  readonly #headers: Headers;

  constructor(
    private readonly http: HttpClient,
    userAgent: string,
  ) {
    if (userAgent.trim() === "")
      throw new ResearchError(
        "INVALID_INPUT",
        "SEC requires a declared User-Agent.",
      );
    this.#headers = new Headers({ "User-Agent": userAgent });
  }

  async query(
    query: SecConceptQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<FundamentalsData>> {
    if (
      query.scope.security.market !== "US" ||
      query.scope.security.currency !== "USD"
    ) {
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "SEC concept normalization supports US securities and USD facts.",
      );
    }
    const tag = CONCEPTS[query.field];
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${query.cik}/us-gaap/${tag}.json`;
    const text = await this.http.getText(url, {
      headers: this.#headers,
      ...(signal && { signal }),
    });
    const retrievedAt = new Date().toISOString();
    const response = parseSourceJson(text);
    if (
      response.cik !== Number(query.cik) ||
      response.taxonomy !== "us-gaap" ||
      response.tag !== tag
    ) {
      sourceError("concept", "CIK, taxonomy or tag does not match the request");
    }
    const units = sourceObject(response.units, "units");
    if (units.USD === undefined)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "SEC concept contains no USD facts.",
      );
    const cutoffMs = Date.parse(query.scope.cutoff);
    const cutoffDate = filedDateFormatter.format(cutoffMs);
    const observations: FundamentalObservation[] = [];
    for (const item of sourceArray(units.USD, "units.USD")) {
      const row = sourceObject(item, "fact");
      const periodStart = sourceDate(row.start);
      const periodEnd = sourceDate(row.end);
      const filed = sourceDate(row.filed);
      if (periodStart > periodEnd) sourceError("period", "start is after end");
      if (periodEnd > filed)
        sourceError("period", "observation period ends after the filing date");
      if (
        periodEnd < query.periodEndFrom ||
        periodEnd > query.scope.date ||
        filed > cutoffDate ||
        Date.parse(`${periodEnd}T23:59:59.999Z`) > cutoffMs
      )
        continue;
      if (
        typeof row.accn !== "string" ||
        !/^\d{10}-\d{2}-\d{6}$/.test(row.accn)
      )
        sourceError("accn", "expected an SEC accession number");
      if (typeof row.form !== "string" || row.form.trim() === "")
        sourceError("form", "expected a filing form");
      const value = row.val === undefined || row.val === null ? null : row.val;
      if (
        value !== null &&
        (typeof value !== "number" || !Number.isFinite(value))
      )
        sourceError("val", "expected a finite amount or null");
      observations.push({
        periodStart,
        periodEnd,
        value,
        filed,
        accession: row.accn,
        form: row.form,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${Number(query.cik)}/${row.accn.replaceAll("-", "")}/${row.accn}-index.html`,
        availableAt: null,
      });
    }
    observations.sort(
      (left, right) =>
        left.periodEnd.localeCompare(right.periodEnd) ||
        left.periodStart.localeCompare(right.periodStart) ||
        left.filed.localeCompare(right.filed) ||
        left.accession.localeCompare(right.accession),
    );
    const latest = observations.at(-1);
    if (latest === undefined)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "No facts within the requested periods and filing-date cutoff.",
      );
    const asOf = `${latest.periodEnd}T23:59:59.999Z`;
    const ageMs = cutoffMs - Date.parse(asOf);
    const stale = ageMs > query.maxAgeMs;
    const gaps: DataGap[] = [
      {
        code: "unverified_time",
        field: "/data/observations",
        detail:
          "SEC companyconcept is a current aggregation. Filing dates have no publication time here and do not prove the historical version visible at cutoff.",
      },
    ];
    for (const [index, observation] of observations.entries()) {
      if (observation.value === null)
        gaps.push({
          code: "missing",
          field: `/data/observations/${index}/value`,
          detail: `${query.field} is absent in ${observation.accession}.`,
        });
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
        field: query.field,
        currency: "USD",
        concept: { taxonomy: "us-gaap", tag },
        observations,
      },
      source: {
        provider: "sec",
        url,
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
