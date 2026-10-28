import { isDeepStrictEqual } from "node:util";
import type { ArtifactVersion } from "../contracts/artifacts.js";
import type {
  ArtifactRef,
  ResearchScope,
  SourceRef,
} from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  ReplayEvidenceSource,
  ReplaySnapshot,
} from "../contracts/replay.js";
import type {
  EvidenceQuery,
  MemoryInputQuery,
  MemoryInputRegistration,
  MemoryInputSnapshot,
  RegisteredEvidenceRecord,
} from "../contracts/task-data.js";
import { artifactKey } from "./run-dependencies.js";

export interface ReplayDataReader {
  artifact(ref: ArtifactRef): ArtifactVersion;
  evidence(ref: ReplayEvidenceSource): RegisteredEvidenceRecord<unknown>;
  memory(ref: MemoryInputRegistration): MemoryInputSnapshot<unknown>;
  evidenceQueries(refs: readonly ReplayEvidenceSource[]): {
    scope: ResearchScope;
    query: EvidenceQuery;
  }[];
  memoryQueries(refs: readonly MemoryInputRegistration[]): {
    scope: ResearchScope;
    query: MemoryInputQuery;
  }[];
}

function missing(message: string): never {
  throw new ResearchError("DATA_INSUFFICIENT", message);
}
function sourceKey(ref: ReplayEvidenceSource): string {
  return JSON.stringify([ref.runId, ref.evidenceId]);
}
function uniqueSources(
  refs: readonly ReplayEvidenceSource[],
): ReplayEvidenceSource[] {
  return [
    ...new Map(
      refs.map((ref) => [
        sourceKey(ref),
        { runId: ref.runId, evidenceId: ref.evidenceId },
      ]),
    ).values(),
  ];
}
function referencedSources(
  outputs: readonly ArtifactRef[],
  reader: ReplayDataReader,
): ReplayEvidenceSource[] {
  const artifacts = new Map<string, ArtifactVersion>();
  const visited = new Set<string>();
  const sources: SourceRef[] = [];
  function load(ref: ArtifactRef): ArtifactVersion {
    const key = artifactKey(ref);
    let artifact = artifacts.get(key);
    if (artifact === undefined) {
      artifact = reader.artifact(ref);
      artifacts.set(key, artifact);
    }
    return artifact;
  }
  function visit(ref: ArtifactRef, claimId: string): void {
    const key = JSON.stringify([artifactKey(ref), claimId]);
    if (visited.has(key)) return;
    visited.add(key);
    const claim = load(ref).content.claims.find(
      (claim) => claim.id === claimId,
    )!;
    if (claim.kind === "observed") sources.push(claim.source);
    else if (claim.kind === "estimated") sources.push(...claim.evidence);
    else
      for (const input of claim.inputs)
        visit(input.kind === "local" ? ref : input.artifact, input.claimId);
  }
  for (const ref of outputs)
    for (const claim of load(ref).content.claims) visit(ref, claim.id);
  return uniqueSources(sources);
}
function taskSnapshot(snapshot: ReplaySnapshot, taskId: string) {
  const task = snapshot.tasks.find((task) => task.taskId === taskId);
  if (task === undefined) missing(`No saved input catalog for task ${taskId}.`);
  return task;
}
function one<T>(matches: T[], name: string): T {
  if (matches.length !== 1)
    missing(
      matches.length === 0
        ? `No saved ${name} matches this query.`
        : `Multiple saved ${name} match this query; select an original reference.`,
    );
  return matches[0]!;
}

export function selectReplayEvidence(
  snapshot: ReplaySnapshot,
  taskId: string,
  scope: ResearchScope,
  query: EvidenceQuery,
  source: ReplayEvidenceSource | null,
  reader: ReplayDataReader,
): { source: SourceRef; record: RegisteredEvidenceRecord<unknown> } {
  const task = taskSnapshot(snapshot, taskId);
  const registered = task.evidenceRefs;
  function matches(refs: readonly ReplayEvidenceSource[]) {
    const unique = uniqueSources(refs);
    const savedQueries = reader.evidenceQueries(unique);
    return unique.filter((_ref, index) => {
      const saved = savedQueries[index]!;
      return (
        isDeepStrictEqual(saved.scope, scope) &&
        isDeepStrictEqual(saved.query, query)
      );
    });
  }
  let selected: ReplayEvidenceSource;
  if (source !== null) {
    const recorded = registered.filter(
      (ref) => sourceKey(ref) === sourceKey(source),
    );
    const eligible =
      recorded.length === 0
        ? referencedSources(task.outputRefs, reader).filter(
            (ref) => sourceKey(ref) === sourceKey(source),
          )
        : recorded;
    selected = one(matches(eligible), "evidence");
  } else {
    const preferred = matches(referencedSources(task.outputRefs, reader));
    selected = one(
      preferred.length === 0 ? matches(registered) : preferred,
      "evidence",
    );
  }
  return {
    source: { ...selected, selector: "/data" },
    record: reader.evidence(selected),
  };
}

export function selectReplayMemory(
  snapshot: ReplaySnapshot,
  taskId: string,
  scope: ResearchScope,
  query: MemoryInputQuery,
  source: MemoryInputRegistration | null,
  reader: ReplayDataReader,
): { source: MemoryInputRegistration; record: MemoryInputSnapshot<unknown> } {
  const task = taskSnapshot(snapshot, taskId);
  const refs = task.memoryRefs.map((inputRef) => ({
    runId: snapshot.sourceRunId,
    inputRef,
  }));
  const eligible =
    source === null
      ? refs
      : refs.filter((ref) => isDeepStrictEqual(ref, source));
  const savedQueries = reader.memoryQueries(eligible);
  const selected = one(
    eligible.filter((_ref, index) => {
      const saved = savedQueries[index]!;
      return (
        isDeepStrictEqual(saved.scope, scope) &&
        isDeepStrictEqual(saved.query, query)
      );
    }),
    "memory snapshot",
  );
  return { source: selected, record: reader.memory(selected) };
}
