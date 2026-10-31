import type {
  ReportedGap,
  GapSummary,
  ResearchArtifactVersion,
} from "../contracts/artifact-payloads.js";
import type { DataGap, SourceRef } from "../contracts/data.js";

function originKey(entry: ReportedGap): readonly (string | number)[] {
  return entry.kind === "source"
    ? [
        entry.kind,
        entry.source.runId,
        entry.source.evidenceId,
        entry.source.selector,
      ]
    : [
        entry.kind,
        entry.artifact.runId,
        entry.artifact.artifactId,
        entry.artifact.revision,
      ];
}

/** Exact duplicates share an origin; equal field names from different origins remain distinct. */
export function aggregateArtifactGaps(
  versions: readonly ResearchArtifactVersion[],
  sources: readonly { source: SourceRef; gaps: readonly DataGap[] }[],
): ReportedGap[] {
  const gaps = new Map<string, ReportedGap>();
  const add = (entry: ReportedGap) => {
    gaps.set(
      JSON.stringify([
        ...originKey(entry),
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

/** Summarize original records; full reasons remain in their source or analysis artifact. */
export function summarizeArtifactGaps(
  gaps: readonly ReportedGap[],
): GapSummary[] {
  const groups = new Map<string, GapSummary>();
  for (const entry of gaps) {
    const fieldPattern = entry.gap.field.replace(
      /\/(rows|bars|observations|items)\/\d+(?=\/|$)/g,
      "/$1/*",
    );
    const key = JSON.stringify([
      ...originKey(entry),
      entry.gap.code,
      fieldPattern,
    ]);
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, { ...entry, fieldPattern, count: 1 });
    else group.count++;
  }
  return [...groups.values()];
}
