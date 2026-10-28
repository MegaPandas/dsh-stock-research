import type { CollectionReadSource } from "../contracts/collection.js";
import type { NumericClaim } from "../contracts/artifacts.js";
import type { ResearchScope, SourceRef } from "../contracts/data.js";
import { numberField } from "../services/number-fields.js";
import {
  EvidenceTimeError,
  verifyEvidence,
} from "../services/evidence-checks.js";
export type RegisteredTable = CollectionReadSource & { sourceRef: SourceRef };
export function referencePrice(
  tables: readonly RegisteredTable[],
  scope: ResearchScope,
): NumericClaim[] {
  const table = tables.find(({ id }) => id === "market.daily");
  if (table === undefined) return [];
  const { envelope, sourceRef } = table;
  const index = envelope.data.rows.length - 1;
  const row = envelope.data.rows[index];
  const column = envelope.data.columns.close;
  if (
    row === undefined ||
    column?.unit !== `${scope.security.currency}/share` ||
    !column.price ||
    row.values.close === null ||
    row.values.close === undefined
  )
    return [];
  const source = { ...sourceRef, selector: `/data/rows/${index}/values/close` };
  try {
    verifyEvidence(
      scope,
      envelope,
      source,
      numberField(envelope, source.selector),
      [],
    );
  } catch (cause) {
    if (!(cause instanceof EvidenceTimeError)) throw cause;
    return [];
  }
  return [
    {
      id: "market.close",
      kind: "observed",
      value: row.values.close,
      unit: column.unit,
      source,
    },
  ];
}
