import type {
  ArtifactInput,
  ArtifactVersion,
  DecisionDraftValidation,
} from "./artifacts.js";
import type { ArtifactRef, SourceRef } from "./data.js";
import type { NumberContext } from "./numbers.js";
import type { ReplayEvidenceSource, ReplaySnapshot } from "./replay.js";
import type {
  ArtifactCommitResult,
  AttemptFailureResult,
  BlockReasonInput,
  BlockRunResult,
  ClaimResult,
  OpenRunInput,
  ResearchRun,
  RunInputCatalog,
  RunOperation,
  RunView,
  TaskAttempt,
  TaskFailure,
  TaskOperation,
  ValuationCalculationRegistration,
} from "./runs.js";
import type { ContentRef } from "./storage.js";
import type {
  EvidenceCall,
  EvidenceInput,
  EvidenceQuery,
  MemoryInputCall,
  MemoryInputQuery,
  MemoryInputRegistration,
  MemorySnapshotEntry,
  RegisteredEvidenceRecord,
} from "./task-data.js";
import type { ValuationCalculation } from "./valuation.js";

export interface RunReader {
  view(operation: Pick<RunOperation, "runId">): RunView;
  readAttempt(
    operation: Pick<TaskOperation, "runId" | "taskId" | "attempt">,
  ): TaskAttempt;
  readArtifact(ref: ArtifactRef): ArtifactVersion;
  readEvidence<T>(
    ref: Pick<SourceRef, "runId" | "evidenceId">,
  ): RegisteredEvidenceRecord<T>;
  readInput<T>(runId: string, ref: ContentRef): T;
  readInputs<T>(runId: string, refs: readonly ContentRef[]): T[];
  inputCatalog(runId: string): RunInputCatalog;
  readDefinition(runId: string): OpenRunInput["definition"];
  replaySnapshot(runId: string): ReplaySnapshot | null;
  numberContext(runId: string): NumberContext;
}

export interface RunCommands {
  artifactForCall(
    operation: TaskOperation,
    contents: unknown,
    requestId: string,
  ): ArtifactCommitResult | null;
  commitArtifact(
    operation: TaskOperation,
    contents: readonly ArtifactInput[],
    requestId: string,
    decisionValidation?: DecisionDraftValidation,
  ): ArtifactCommitResult;
  finalize(
    operation: TaskOperation,
    decision: ArtifactInput,
    report: ArtifactInput,
    requestId: string,
  ): ArtifactCommitResult;
  claimService(
    operation: RunOperation,
    taskId: string,
    service: "digest" | "finalize",
    requestId: string,
  ): ClaimResult;
  claimServiceForCall(
    operation: RunOperation,
    taskId: string,
    service: "digest" | "finalize",
    requestId: string,
  ): { claim: ClaimResult; replayed: boolean };
  serviceForCall(
    operation: TaskOperation,
    requestId: string,
    action: "commit_artifact" | "finalize",
  ): {
    result: ArtifactCommitResult | null;
    context: Pick<ResearchRun, "scope" | "definition" | "tasks">;
  };
  failAttempt(
    operation: TaskOperation,
    failure: TaskFailure,
    requestId: string,
  ): AttemptFailureResult;
  failServiceAttempt(
    operation: TaskOperation,
    failure: TaskFailure,
    requestId: string,
  ): AttemptFailureResult | null;
  block(
    operation: RunOperation,
    reasons: readonly BlockReasonInput[],
    requestId: string,
  ): BlockRunResult;
  evidenceForCall(
    operation: TaskOperation,
    query: EvidenceQuery,
    callId: string,
    source?: ReplayEvidenceSource | null,
  ): EvidenceCall;
  recordEvidence<T>(
    operation: TaskOperation,
    query: EvidenceQuery,
    input: EvidenceInput<T>,
    callId: string,
  ): SourceRef;
  replayEvidence(
    operation: TaskOperation,
    query: EvidenceQuery,
    callId: string,
    source?: ReplayEvidenceSource | null,
  ): SourceRef;
  memoryInputForCall(
    operation: TaskOperation,
    query: MemoryInputQuery,
    callId: string,
    source?: MemoryInputRegistration | null,
  ): MemoryInputCall;
  recordMemoryInput<T>(
    operation: TaskOperation,
    query: MemoryInputQuery,
    entries: readonly MemorySnapshotEntry<T>[],
    callId: string,
  ): MemoryInputRegistration;
  replayMemoryInput(
    operation: TaskOperation,
    query: MemoryInputQuery,
    callId: string,
    source?: MemoryInputRegistration | null,
  ): MemoryInputRegistration;
  valuationCalculationForCall(
    operation: TaskOperation,
    request: ValuationCalculation["request"],
    callId: string,
  ): ValuationCalculation | null;
  recordValuationCalculation(
    operation: TaskOperation,
    calculation: Omit<
      ValuationCalculation,
      "kind" | "calculationId" | "runId" | "taskId" | "attempt" | "createdAt"
    >,
    callId: string,
  ): ValuationCalculationRegistration;
}
