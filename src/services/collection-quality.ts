import type { CollectedTableData } from "../contracts/collection.js";
import type { DataEnvelope } from "../contracts/data.js";

// Each inner group permits source-reported alternatives within one table.
const CORE_FIELDS: Record<string, readonly (readonly string[])[]> = {
  "benchmark.bondYields": [["china10y", "us10y"]],
  "financial.indicators": [["TOTALOPERATEREVE"], ["PARENTNETPROFIT"], ["BPS"]],
  "financial.quarter": [["TOTALOPERATEREVE"], ["PARENTNETPROFIT"]],
  "financial.income": [
    ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"],
    ["PARENT_NETPROFIT"],
  ],
  "financial.balance": [
    ["TOTAL_ASSETS"],
    ["TOTAL_LIABILITIES"],
    ["TOTAL_PARENT_EQUITY"],
  ],
  "financial.cashflow": [["NETCASH_OPERATE"], ["CONSTRUCT_LONG_ASSET"]],
};

function coreFields(data: CollectedTableData): readonly (readonly string[])[] {
  return (
    CORE_FIELDS[data.table] ??
    (data.table === "market.daily" ||
    data.table === "market.weekly" ||
    data.table === "market.monthly"
      ? [["open"], ["high"], ["low"], ["close"], ["volume"]]
      : data.table.startsWith("benchmark.") && data.interval !== undefined
        ? [["close"]]
        : [])
  );
}

function missingCoreValues(data: CollectedTableData): number {
  return coreFields(data).reduce(
    (count, fields) =>
      count +
      data.rows.filter(
        (row) => !fields.some((field) => row.values[field] != null),
      ).length,
    0,
  );
}

/** Replace a partial table only when coverage improves without a trade-off. */
export function improvesCollectionCoverage(
  current: DataEnvelope<CollectedTableData>,
  candidate: DataEnvelope<CollectedTableData>,
): boolean {
  const currentMissing = missingCoreValues(current.data);
  const candidateMissing = missingCoreValues(candidate.data);
  if (
    (!current.stale && candidate.stale) ||
    candidate.asOf < current.asOf ||
    candidate.data.rows.length < current.data.rows.length ||
    candidateMissing > currentMissing
  )
    return false;
  return (
    (current.stale && !candidate.stale) ||
    candidate.asOf > current.asOf ||
    candidate.data.rows.length > current.data.rows.length ||
    candidateMissing < currentMissing
  );
}

export function collectionCoverageIssue(
  envelope: DataEnvelope<CollectedTableData>,
): string | undefined {
  const { data } = envelope;
  if (data.rows.length === 0) return "The source returned no observations.";
  const groups = coreFields(data);
  const missing = groups.filter((fields) =>
    data.rows.some((row) => !fields.some((field) => row.values[field] != null)),
  );
  if (missing.length > 0)
    return `Core fields are missing in one or more observations: ${missing.map((fields) => fields.join(" or ")).join(", ")}.`;
  if (envelope.stale)
    return "The source observations exceed the freshness budget.";
  return envelope.gaps.find(
    (gap) => gap.code === "missing" && gap.field === "/data/rows",
  )?.detail;
}
