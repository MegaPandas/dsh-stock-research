import type {
  CollectedTableData,
  CollectionDataset,
  CollectionRow,
} from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { sourceError } from "./source.js";
import { COLLECTION_VERSION } from "./versions.js";

export { COLLECTION_VERSION } from "./versions.js";

export function collectedNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "" || value === "-")
    return null;
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
  )
    sourceError(field, "expected a numeric source value or missing marker");
  const number = Number(value);
  if (!Number.isFinite(number))
    sourceError(field, "expected a finite numeric source value");
  return number;
}

export function collectedEnvelope(
  scope: ResearchScope,
  dataset: CollectionDataset,
  data: CollectedTableData,
  provider: string,
  url: string,
  retrievedAt: string,
): DataEnvelope<CollectedTableData> {
  if (data.rows.length === 0)
    throw new ResearchError(
      "DATA_INSUFFICIENT",
      `No ${data.title} observations are available within the requested window.`,
    );
  data.rows.sort((a, b) => a.date.localeCompare(b.date));
  const dates = new Set<string>();
  for (const row of data.rows) {
    if (dates.has(row.date))
      sourceError(data.table, `duplicate observation ${row.date}`);
    dates.add(row.date);
  }
  const asOf = data.rows.at(-1)!.asOf;
  return {
    dataset,
    data,
    source: {
      provider,
      url,
      adapterVersion: COLLECTION_VERSION,
      normalizationVersion: COLLECTION_VERSION,
    },
    asOf,
    availableAt: null,
    retrievedAt,
    cutoff: scope.cutoff,
    ageMs: Date.parse(scope.cutoff) - Date.parse(asOf),
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data/rows",
        detail:
          "The source supplies its current historical view; observation dates do not establish publication times or historical revisions.",
      },
      ...data.rows.flatMap((row, index) =>
        Object.keys(data.columns)
          .filter((key) => row.values[key] === null)
          .map((key) => ({
            code: "missing" as const,
            field: `/data/rows/${index}/values/${key}`,
            detail: `${data.columns[key]!.label} is absent for ${row.date}.`,
          })),
      ),
    ],
  };
}

export function collectionRow(
  date: string,
  values: CollectionRow["values"],
  scope: ResearchScope,
): CollectionRow {
  return {
    date,
    asOf: `${date}T00:00:00.000Z`,
    availableAt: null,
    complete: `${date}T00:00:00.000Z` <= scope.cutoff,
    values,
  };
}
