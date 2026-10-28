import type { ArtifactRef, SourceRef } from "./data.js";
import type { ContentRef } from "./storage.js";
import type { RunVersions } from "./runs.js";
import type {
  EvidenceQuery,
  MemoryInputQuery,
  MemoryInputRegistration,
} from "./task-data.js";

export type ReplayEvidenceSource = Pick<SourceRef, "runId" | "evidenceId">;
export interface ReplayEvidenceRequest {
  query: EvidenceQuery;
  source: ReplayEvidenceSource | null;
}
export interface ReplayMemoryRequest {
  query: MemoryInputQuery;
  source: MemoryInputRegistration | null;
}

export interface ReplayRunInput {
  replay: { runId: string };
  versions: RunVersions;
}
export interface ReplayTaskSnapshot {
  taskId: string;
  attempt: number | null;
  outputRefs: ArtifactRef[];
  evidenceRefs: SourceRef[];
  memoryRefs: ContentRef[];
  instructionRef: ContentRef | null;
}
export interface ReplaySnapshot {
  sourceRunId: string;
  sourceRevision: number;
  tasks: ReplayTaskSnapshot[];
}
export interface RunLineage {
  sourceRunId: string;
  sourceRevision: number;
  snapshotRef: ContentRef;
}
