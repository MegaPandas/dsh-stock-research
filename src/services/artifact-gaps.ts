import type { ReportedGap } from "../contracts/artifact-payloads.js";
import type { DataGap, SourceRef } from "../contracts/data.js";
import type { ResearchArtifactVersion } from "./artifact-inputs.js";

/** Exact duplicates share an origin; equal field names from different origins remain distinct. */
export function aggregateArtifactGaps(
  versions: readonly ResearchArtifactVersion[],
  sources: readonly { source: SourceRef; gaps: readonly DataGap[] }[],
): ReportedGap[] {
  const gaps = new Map<string, ReportedGap>();
  const add = (entry: ReportedGap) => {
    const origin =
      entry.kind === "source"
        ? [entry.source.runId, entry.source.evidenceId, entry.source.selector]
        : [
            entry.artifact.runId,
            entry.artifact.artifactId,
            entry.artifact.revision,
          ];
    gaps.set(
      JSON.stringify([
        entry.kind,
        ...origin,
        entry.gap.code,
        entry.gap.field,
        entry.gap.detail,
      ]),
      entry,
    );
  };
  for (const version of versions) {
    if (
      version.content.kind === "analysis" &&
      !("schemaVersion" in version.content.payload)
    )
      for (const gap of version.content.payload.gaps)
        add({ kind: "artifact", artifact: version.ref, gap });
    if (version.content.kind === "digest" || version.content.kind === "report")
      for (const gap of version.content.payload.gaps) add(gap);
  }
  for (const { source, gaps: values } of sources)
    for (const gap of values)
      add({
        kind: "source",
        source: {
          runId: source.runId,
          evidenceId: source.evidenceId,
          selector: "",
        },
        gap,
      });
  return [...gaps.values()];
}
