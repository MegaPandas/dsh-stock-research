import type { ArtifactKind } from "./artifacts.js";
import type { JsonValue } from "./cache.js";
import type { ArtifactRef, ISOTime, ResearchScope, SourceRef } from "./data.js";
import type { ContentRef, StoredRun } from "./storage.js";
import type { MemoryInputRegistration, RunEvidence } from "./task-data.js";
import type { RunDefinition, TaskDefinition } from "./workflow.js";
import type { RunLineage } from "./replay.js";

export type RunStatus = "active" | "blocked" | "completed" | "cancelled";
export type TaskStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskFailure {
  code: string;
  message: string;
}
export interface TaskAttempt {
  number: number;
  status: "running" | "succeeded" | "failed" | "invalidated" | "cancelled";
  inputRefs: ArtifactRef[];
  outputRefs: ArtifactRef[];
  instructionVersion: number;
  instructionRef?: ContentRef;
  sessionId: string | null;
  startedAt: ISOTime;
  endedAt: ISOTime | null;
  failure: TaskFailure | null;
}
export interface TaskState {
  taskId: string;
  status: TaskStatus;
  attempts: TaskAttempt[];
  outputRefs: ArtifactRef[];
}
export interface RunVersions {
  plugin: string;
  mode: string;
  prompts: Record<string, string>;
  skills: Record<string, string>;
  adapters: Record<string, string>;
  normalization: Record<string, string>;
}
export interface RunInput {
  name: string;
  content: JsonValue;
}
export interface RunInputReference {
  name: string;
  ref: ContentRef;
  instruction?: { taskId: string; version: number };
  memory?: { taskId: string; attempt: number; callId: string };
}
export interface TaskInstructionUpdate {
  taskId: string;
  instruction: string;
}
export interface TaskInstructionSnapshot extends TaskInstructionUpdate {
  version: number;
  previous: ContentRef | null;
  baseDefinition: ContentRef;
  recordedAt: ISOTime;
}
export interface ResumeRunInput {
  resolvedReasonIds: string[];
  instructions: TaskInstructionUpdate[];
}
export interface OpenRunInput {
  definition: RunDefinition;
  versions: RunVersions;
  inputs: RunInput[];
  instructions?: TaskInstructionUpdate[];
}
export interface RunInputCatalog {
  versions: RunVersions;
  inputs: RunInputReference[];
}
export interface RunOperation {
  runId: string;
  identity: string;
}
export interface TaskOperation extends RunOperation {
  taskId: string;
  attempt: number;
  sessionId: string | null;
}
export interface ClaimResult {
  runId: string;
  taskId: string;
  attempt: number;
  inputRefs: ArtifactRef[];
  instructionVersion: number;
  instructionRef?: ContentRef;
}
export interface RoleDispatchContext {
  claim: ClaimResult;
  scope: ResearchScope;
  definition: TaskDefinition & {
    executor: Extract<TaskDefinition["executor"], { kind: "role" }>;
  };
  attempt: TaskAttempt;
  replayed: boolean;
}
export interface ArtifactCommitResult {
  runId: string;
  taskId: string;
  attempt: number;
  refs: ArtifactRef[];
}
export interface AttemptFailureResult {
  runId: string;
  taskId: string;
  attempt: number;
}
export interface AttemptTarget {
  taskId: string;
  attempt: number;
}
export interface CancelRunResult {
  runId: string;
  status: "cancelled";
  stopAttempts: AttemptTarget[];
}
export interface BlockRunResult {
  runId: string;
  status: "blocked";
  reasonIds: string[];
}
export interface ResumeRunResult {
  runId: string;
  status: "active" | "blocked";
  revisedTasks: string[];
  remainingReasonIds: string[];
}
export interface RedoTaskResult {
  runId: string;
  taskId: string;
  status: "active" | "blocked";
  affectedTasks: string[];
  stopAttempts: AttemptTarget[];
  invalidatedRefs: ArtifactRef[];
}
export interface RecoverAttemptsResult {
  runId: string;
  failedAttempts: AttemptTarget[];
}
export interface StageReviewInput {
  stageId: string;
  verdict: "accepted" | "rejected";
  feedback: string;
  refs: ArtifactRef[];
}
export interface StageReview extends StageReviewInput {
  identity: string;
  recordedAt: ISOTime;
  requestId: string;
}
export interface StageReviewResult {
  runId: string;
  review: StageReview;
}
export interface StageView {
  id: string;
  taskIds: string[];
  beforeTasks: string[];
  readyForReview: boolean;
  accepted: boolean;
  refs: ArtifactRef[];
  latestReview?: StageReview;
}
export type RunWriteResult =
  | { runId: string }
  | ClaimResult
  | ArtifactCommitResult
  | AttemptFailureResult
  | CancelRunResult
  | BlockRunResult
  | ResumeRunResult
  | RedoTaskResult
  | RecoverAttemptsResult
  | StageReviewResult
  | SourceRef
  | MemoryInputRegistration;
export type ReceiptAction =
  | "open"
  | "claim"
  | "dispatch_stage"
  | "commit_artifact"
  | "finalize"
  | "fail_attempt"
  | "cancel"
  | "block"
  | "resume"
  | "redo"
  | "recover_attempts"
  | "record_evidence"
  | "record_memory_input"
  | "replay_evidence"
  | "replay_memory_input"
  | "review_stage";
export interface RunReceipt {
  scope: string;
  action: ReceiptAction;
  requestId: string;
  request: ContentRef;
  result: RunWriteResult;
}
export interface RunArtifact {
  ref: ArtifactRef;
  kind: ArtifactKind;
  taskId: string;
  attempt: number;
  createdAt: ISOTime;
}
export interface BlockReasonInput {
  taskId: string | null;
  attempt: number | null;
  code: string;
  message: string;
}
export interface BlockReason extends BlockReasonInput {
  id: string;
}
export interface RunState {
  stateVersion: 3;
  lineage: RunLineage | null;
  scope: ResearchScope;
  mode: "quick" | "deep";
  definition: RunDefinition;
  definitionRef: ContentRef;
  inputs: RunInputReference[];
  status: RunStatus;
  tasks: TaskState[];
  artifacts: RunArtifact[];
  evidence: RunEvidence[];
  receipts: RunReceipt[];
  versions: RunVersions;
  createdAt: ISOTime;
  updatedAt: ISOTime;
  completedAt: ISOTime | null;
  blockReasons: BlockReason[];
  stageReviews?: StageReview[];
}
export type ResearchRun = StoredRun<RunState>;
export interface RunView {
  runId: string;
  lineage: RunLineage | null;
  scope: ResearchScope;
  mode: "quick" | "deep";
  status: RunStatus;
  readyTasks: string[];
  tasks: {
    taskId: string;
    status: TaskStatus;
    attempt: number;
    outputRefs: ArtifactRef[];
    failure: TaskFailure | null;
  }[];
  currentDigest: ArtifactRef | null;
  blockReasons: BlockReason[];
  stages?: StageView[];
  stageReviews?: StageReview[];
}
