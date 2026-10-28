import type { JsonValue } from "./cache.js";
import type {
  CandidateClaim,
  DataEnvelope,
  EvidenceRecord,
  ISOTime,
  ResearchScope,
  SourceRef,
} from "./data.js";
import type { MemoryRef } from "./memory.js";
import type { RunLineage } from "./replay.js";
import type { ContentRef } from "./storage.js";

export type EvidenceQuery = Omit<
  EvidenceRecord<unknown>["request"],
  "securityId"
>;
export interface CandidateSeed extends Omit<CandidateClaim, "source"> {
  selector: string;
}
export interface EvidenceInput<T> {
  envelope: Omit<DataEnvelope<T>, "candidateClaims">;
  candidates: CandidateSeed[];
}
export interface RegisteredEvidenceRecord<T> extends EvidenceRecord<T> {
  envelope: DataEnvelope<T> & { candidateClaims: CandidateClaim[] };
}
export interface RunEvidence {
  evidenceId: string;
  taskId: string;
  attempt: number;
  callId: string;
}
export interface EvidenceCall {
  scope: ResearchScope;
  lineage: RunLineage | null;
  sourceRef: SourceRef | null;
}
export interface MemoryInputQuery {
  scope: JsonValue;
  parameters: Record<string, JsonValue>;
}
export interface MemorySnapshotEntry<T> {
  ref: MemoryRef;
  content: T;
}
export interface MemoryInputSnapshot<T> {
  runId: string;
  taskId: string;
  attempt: number;
  scope: ResearchScope;
  request: MemoryInputQuery;
  entries: MemorySnapshotEntry<T>[];
  recordedAt: ISOTime;
  replayedFrom?: MemoryInputRegistration;
}
export interface MemoryInputRegistration {
  runId: string;
  inputRef: ContentRef;
}
export interface MemoryInputCall {
  scope: ResearchScope;
  lineage: RunLineage | null;
  inputRef: ContentRef | null;
}
