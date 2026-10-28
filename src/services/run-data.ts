import type { SourceRef } from "../contracts/data.js";
import type { ResearchRun, TaskOperation } from "../contracts/runs.js";
import type { ContentWriter } from "../contracts/storage.js";
import type {
  EvidenceInput,
  EvidenceQuery,
  MemoryInputQuery,
  MemoryInputRegistration,
  MemoryInputSnapshot,
  MemorySnapshotEntry,
  RegisteredEvidenceRecord,
} from "../contracts/task-data.js";
import { currentAttempt } from "./run-control.js";

export function persistEvidence<T>(
  run: ResearchRun,
  writer: ContentWriter,
  operation: TaskOperation,
  query: EvidenceQuery,
  input: EvidenceInput<T>,
  callId: string,
  replayedFrom: SourceRef | null = null,
): SourceRef {
  currentAttempt(run, operation);
  const ref = writer.evidence((evidenceId): RegisteredEvidenceRecord<T> => ({
    evidenceId,
    runId: run.runId,
    taskId: operation.taskId,
    attempt: operation.attempt,
    request: { ...query, securityId: run.scope.security.id },
    envelope: {
      ...input.envelope,
      candidateClaims: input.candidates.map(({ selector, ...candidate }) => ({
        ...candidate,
        source: { runId: run.runId, evidenceId, selector },
      })),
    },
    recordedAt: run.updatedAt,
    ...(replayedFrom === null ? {} : { replayedFrom }),
  }));
  run.evidence.push({
    evidenceId: ref.id,
    taskId: operation.taskId,
    attempt: operation.attempt,
    callId,
  });
  return { runId: run.runId, evidenceId: ref.id, selector: "/data" };
}

export function persistMemoryInput<T>(
  run: ResearchRun,
  writer: ContentWriter,
  operation: TaskOperation,
  query: MemoryInputQuery,
  entries: readonly MemorySnapshotEntry<T>[],
  callId: string,
  replayedFrom: MemoryInputRegistration | null = null,
): MemoryInputRegistration {
  currentAttempt(run, operation);
  const snapshot: MemoryInputSnapshot<T> = {
    runId: run.runId,
    taskId: operation.taskId,
    attempt: operation.attempt,
    scope: run.scope,
    request: query,
    entries: [...entries],
    recordedAt: run.updatedAt,
    ...(replayedFrom === null ? {} : { replayedFrom }),
  };
  const inputRef = writer.input(() => snapshot);
  run.inputs.push({
    name: "memory",
    ref: inputRef,
    memory: { taskId: operation.taskId, attempt: operation.attempt, callId },
  });
  return { runId: run.runId, inputRef };
}
