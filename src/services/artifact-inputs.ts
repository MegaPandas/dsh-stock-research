import type {
  ResearchArtifactInput,
  ReportedGap,
} from "../contracts/artifact-payloads.js";
import type {
  ArtifactVersion,
  NumberInput,
  NumericClaim,
} from "../contracts/artifacts.js";
import type {
  ArtifactRef,
  DataGap,
  ISOTime,
  SourceRef,
} from "../contracts/data.js";
import type { EvidenceData } from "../contracts/query.js";
import type { RegisteredEvidenceRecord } from "../contracts/task-data.js";
import { artifactReferences } from "./artifact-references.js";
import { isStageReport } from "./analysis-report.js";
import { aggregateArtifactGaps } from "./artifact-gaps.js";
import { numberField, referenceField } from "./number-fields.js";
import { artifactKey } from "./run-dependencies.js";
import { verifyEvidence } from "./evidence-checks.js";
import type { RunService } from "./runs.js";

export type ResearchArtifactVersion = Omit<ArtifactVersion, "content"> & {
  content: ResearchArtifactInput;
};
export interface ArtifactNumber {
  artifact: ArtifactRef;
  claim: NumericClaim;
}
function sourceKey(ref: SourceRef): string {
  return JSON.stringify([ref.runId, ref.evidenceId, ref.selector]);
}
function intersects(path: string, dependency: string): boolean {
  return (
    path === dependency ||
    path.startsWith(`${dependency}/`) ||
    dependency.startsWith(`${path}/`)
  );
}

/** Fixed committed inputs, with an optional validated pending view for submission. */
export class ArtifactInputs {
  private readonly artifacts = new Map<string, ResearchArtifactVersion>();
  private readonly evidence = new Map<
    string,
    RegisteredEvidenceRecord<EvidenceData>
  >();
  constructor(
    private readonly runs: RunService,
    pending: readonly ResearchArtifactVersion[] = [],
  ) {
    for (const version of pending)
      this.artifacts.set(artifactKey(version.ref), version);
  }

  artifact(ref: ArtifactRef): ResearchArtifactVersion {
    const key = artifactKey(ref);
    let version = this.artifacts.get(key);
    if (version === undefined) {
      version = this.runs.readArtifact(ref) as ResearchArtifactVersion;
      this.artifacts.set(key, version);
    }
    return version;
  }
  source(ref: SourceRef): RegisteredEvidenceRecord<EvidenceData> {
    const key = JSON.stringify([ref.runId, ref.evidenceId]);
    let record = this.evidence.get(key);
    if (record === undefined) {
      record = this.runs.readEvidence<EvidenceData>(ref);
      this.evidence.set(key, record);
    }
    return record;
  }
  closure(roots: readonly ArtifactRef[]): ResearchArtifactVersion[] {
    const found = new Set<string>();
    const result: ResearchArtifactVersion[] = [];
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
      const ref = queue[index]!;
      const key = artifactKey(ref);
      if (found.has(key)) continue;
      found.add(key);
      const version = this.artifact(ref);
      result.push(version);
      queue.push(...version.content.inputRefs);
    }
    return result;
  }
  number(input: NumberInput, local: ArtifactRef): ArtifactNumber {
    const ref = input.kind === "local" ? local : input.artifact;
    return {
      artifact: ref,
      claim: this.artifact(ref).content.claims.find(
        (claim) => claim.id === input.claimId,
      )!,
    };
  }
  numberSources(input: NumberInput, local: ArtifactRef): SourceRef[] {
    const value = this.number(input, local);
    switch (value.claim.kind) {
      case "observed":
        return [value.claim.source];
      case "estimated":
        return value.claim.evidence;
      case "calculated":
        return value.claim.inputs.flatMap((input) =>
          this.numberSources(input, value.artifact),
        );
    }
  }
  estimated(input: NumberInput, local: ArtifactRef): boolean {
    const value = this.number(input, local);
    return (
      value.claim.kind === "estimated" ||
      (value.claim.kind === "calculated" &&
        value.claim.inputs.some((input) =>
          this.estimated(input, value.artifact),
        ))
    );
  }
  reportedGaps(versions: readonly ResearchArtifactVersion[]): ReportedGap[] {
    const sources = new Map<string, SourceRef>();
    for (const version of versions)
      for (const source of this.artifactSources(version.ref))
        sources.set(JSON.stringify([source.runId, source.evidenceId]), source);
    return aggregateArtifactGaps(
      versions,
      [...sources.values()].map((source) => ({
        source,
        gaps: this.gaps({ ...source, selector: "" }, false),
      })),
    );
  }
  blockingReportedGaps(
    versions: readonly ResearchArtifactVersion[],
    cutoff: ISOTime,
  ): ReportedGap[] {
    return this.reportedGaps(versions).filter(
      (entry) =>
        entry.kind !== "source" || this.blocks(entry.source, entry.gap, cutoff),
    );
  }
  artifactSources(ref: ArtifactRef): SourceRef[] {
    const version = this.artifact(ref);
    const content = version.content;
    const refs = artifactReferences(content);
    const sources = [
      // Stage notes use their fixed task inputs; this does not assert that a sentence adopted a field.
      ...(isStageReport(content)
        ? this.runs
            .numberContext(ref.runId)
            .evidence.filter(
              (entry) =>
                entry.taskId === version.taskId &&
                entry.attempt === version.attempt,
            )
            .map((entry) => ({
              runId: ref.runId,
              evidenceId: entry.evidenceId,
              selector: "/data",
            }))
        : []),
      ...refs.sources,
      ...refs.numbers.flatMap((input) => this.numberSources(input, ref)),
      ...content.claims.flatMap((claim) =>
        this.numberSources({ kind: "local", claimId: claim.id }, ref),
      ),
    ];
    return [
      ...new Map(sources.map((source) => [sourceKey(source), source])).values(),
    ];
  }
  gaps(ref: SourceRef, numeric: boolean): DataGap[] {
    const { envelope } = this.source(ref);
    const field = numeric
      ? numberField(envelope, ref.selector)
      : referenceField(envelope, ref.selector);
    const gaps = envelope.gaps.filter(
      (gap) =>
        field.dependencies.some((path) => intersects(gap.field, path)) ||
        (gap.field !== "/data" && !gap.field.startsWith("/data/")),
    );
    if (envelope.stale && !gaps.some((gap) => gap.code === "stale"))
      return [
        ...gaps,
        {
          code: "stale",
          field: "/asOf",
          detail: "The snapshot freshness limit was exceeded.",
        },
      ];
    return gaps;
  }
  blockingGaps(ref: SourceRef, numeric: boolean, cutoff: ISOTime): DataGap[] {
    return this.gaps(ref, numeric).filter((gap) =>
      this.blocks(ref, gap, cutoff),
    );
  }
  checkSourceTime(ref: SourceRef, numeric: boolean, cutoff: ISOTime): void {
    const { envelope } = this.source(ref);
    const field = numeric
      ? numberField(envelope, ref.selector)
      : referenceField(envelope, ref.selector);
    verifyEvidence(
      { ...this.runs.numberContext(ref.runId).scope, cutoff },
      envelope,
      ref,
      field,
      [],
    );
  }
  private blocks(ref: SourceRef, gap: DataGap, cutoff: ISOTime): boolean {
    return (
      gap.code !== "unverified_time" ||
      this.source(ref).envelope.retrievedAt > cutoff
    );
  }
  numberGaps(
    input: NumberInput,
    local: ArtifactRef,
    cutoff: ISOTime,
  ): { source: SourceRef; gap: DataGap }[] {
    const value = this.number(input, local);
    if (value.claim.kind === "calculated")
      return value.claim.inputs.flatMap((input) =>
        this.numberGaps(input, value.artifact, cutoff),
      );
    const refs =
      value.claim.kind === "observed"
        ? [value.claim.source]
        : value.claim.evidence;
    const numeric = value.claim.kind === "observed";
    return refs.flatMap((source) =>
      this.blockingGaps(source, numeric, cutoff).map((gap) => ({
        source,
        gap,
      })),
    );
  }
}
