import type { ResearchScope, SourceRef } from "../contracts/data.js";
import type { NumberWarning } from "../contracts/numbers.js";
import type { EvidenceEnvelope } from "../contracts/query.js";
import type { NumberField } from "./number-fields.js";

export class EvidenceTimeError extends Error {}
function intersects(path: string, dependency: string): boolean {
  return (
    path === dependency ||
    path.startsWith(`${dependency}/`) ||
    dependency.startsWith(`${path}/`)
  );
}

/** Shared evidence boundary for numeric fields and nonnumeric payload citations. */
export function verifyEvidence(
  scope: ResearchScope,
  envelope: EvidenceEnvelope,
  ref: SourceRef,
  field: Pick<NumberField, "times" | "dependencies">,
  warnings: NumberWarning[],
): void {
  const scoped = envelope.gaps.filter((gap) =>
    field.dependencies.some((path) => intersects(gap.field, path)),
  );
  const metadata = envelope.gaps.filter(
    (gap) =>
      gap.field !== "/data" &&
      !gap.field.startsWith("/data/") &&
      !scoped.includes(gap),
  );
  const gaps = [...scoped, ...metadata];
  for (const gap of gaps)
    warnings.push({ code: "source_gap", detail: gap.detail, source: ref, gap });
  if (envelope.stale && !gaps.some((gap) => gap.code === "stale"))
    warnings.push({
      code: "stale",
      detail: "The source marks this snapshot as stale.",
      source: ref,
    });
  const unverified =
    scoped.some((gap) => gap.code === "unverified_time") ||
    (metadata.some((gap) => gap.code === "unverified_time") &&
      field.times.some((point) => point.availableAt === null));
  const cutoff = scope.cutoff;
  for (const point of field.times) {
    if (!point.complete || point.asOf > cutoff)
      throw new EvidenceTimeError(
        "The selected observation is incomplete or after cutoff.",
      );
    if (point.availableAt !== null && point.availableAt > cutoff)
      throw new EvidenceTimeError(
        "The selected content became available after cutoff.",
      );
    const captured = envelope.retrievedAt <= cutoff;
    const published = point.availableAt !== null && !unverified;
    const qualified =
      envelope.historicalKnowledge === "verified" &&
      envelope.cutoff <= cutoff &&
      !unverified;
    if (!captured && !published && !qualified)
      throw new EvidenceTimeError(
        "The selected content or version is not established as known by cutoff.",
      );
  }
}
