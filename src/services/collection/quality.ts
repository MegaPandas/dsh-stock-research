import type { CollectedTableData } from "../../contracts/collection.js";
import type { DataEnvelope, ISOTime } from "../../contracts/data.js";
import { FINANCIAL_CORE_FIELDS } from "../../contracts/financial-tables.js";

// Each inner group permits source-reported alternatives within one table.
const CORE_FIELDS: Record<string, readonly (readonly string[])[]> = {
  ...FINANCIAL_CORE_FIELDS,
  "benchmark.bondYields": [["china10y", "us10y"]],
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

export interface CollectionCoverage {
  asOf: ISOTime;
  stale: boolean;
  rowCount: number;
  missingCoreValues: number;
  issue: string | undefined;
}

/** Replace a partial table only when coverage improves without a trade-off. */
export function improvesCollectionCoverage(
  current: CollectionCoverage,
  candidate: CollectionCoverage,
): boolean {
  if (
    (!current.stale && candidate.stale) ||
    candidate.asOf < current.asOf ||
    candidate.rowCount < current.rowCount ||
    candidate.missingCoreValues > current.missingCoreValues
  )
    return false;
  return (
    (current.stale && !candidate.stale) ||
    candidate.asOf > current.asOf ||
    candidate.rowCount > current.rowCount ||
    candidate.missingCoreValues < current.missingCoreValues
  );
}

export function assessCollectionCoverage(
  envelope: DataEnvelope<CollectedTableData>,
): CollectionCoverage {
  const { data } = envelope;
  const missingGroups: string[] = [];
  let missingCoreValues = 0;
  for (const fields of coreFields(data)) {
    let missing = 0;
    for (const row of data.rows) {
      let present = false;
      for (const field of fields)
        if (row.values[field] != null) {
          present = true;
          break;
        }
      if (!present) missing++;
    }
    missingCoreValues += missing;
    if (missing > 0) missingGroups.push(fields.join(" or "));
  }
  let issue: string | undefined;
  if (data.rows.length === 0) issue = "The source returned no observations.";
  else if (missingGroups.length > 0)
    issue = `Core fields are missing in one or more observations: ${missingGroups.join(", ")}.`;
  else if (envelope.stale)
    issue = "The source observations exceed the freshness budget.";
  else
    issue = envelope.gaps.find(
      (gap) => gap.code === "missing" && gap.field === "/data/rows",
    )?.detail;
  return {
    asOf: envelope.asOf,
    stale: envelope.stale,
    rowCount: data.rows.length,
    missingCoreValues,
    issue,
  };
}
