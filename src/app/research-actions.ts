import type { CollectionFailure } from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import type {
  AttemptTarget,
  CancelTaskResult,
  ResumeRunInput,
  RunView,
  StageReviewInput,
  StageReviewResult,
} from "../contracts/runs.js";
import type { RunDefinition, TaskDefinition } from "../contracts/workflow.js";
import type { ResearchCaller } from "../host/bindings.js";
import type { JobView } from "@deepseek-ai/dsh-jobs";
import type {
  ResearchCancelRequest,
  ResearchFollowupRequest,
  ResearchRedoRequest,
} from "../host/research-operations.js";

export interface ResearchHandle {
  jobId: string;
}

export interface ResearchObservation {
  job: JobView;
  runId?: string;
  view?: RunView;
}

export interface ResearchNotice {
  kind: "review" | "blocked" | "completed" | "failed";
  jobId: string;
  runId?: string;
  stageId?: string;
  detail?: string;
}

export interface StartResearchRequest {
  scope: ResearchScope;
  mode: RunDefinition["mode"];
  requestId: string;
}

export interface ReviewResearchRequest extends StageReviewInput {
  runId: string;
  requestId: string;
}

export type ResearchControl =
  | { kind: "status"; runId: string }
  | { kind: "cancel"; runId: string }
  | { kind: "replay"; runId: string }
  | { kind: "resume"; runId: string; input: ResumeRunInput }
  | {
      kind: "redo";
      runId: string;
      taskId: string;
      reason: string | null;
      instruction: string | null;
    }
  | { kind: "recover"; runId: string; attempts: AttemptTarget[] };
export type ResearchControlKind = ResearchControl["kind"];

export interface ResearchContext {
  runId: string;
  view: RunView;
  tasks: { id: string; executor: TaskDefinition["executor"] }[];
  collection?: {
    cutoff: string;
    tables: { id: string; title: string; rows: number }[];
    failures: CollectionFailure[];
  };
}

export type ResearchControlResult =
  | { kind: "status"; view: RunView }
  | { kind: "continuation"; context: ResearchContext; handle: ResearchHandle };

/** Inputs are validated by adapters; caller identity comes from the host. */
export interface ResearchActions {
  start(request: StartResearchRequest, caller: ResearchCaller): ResearchHandle;
  observe(jobId: string, caller: ResearchCaller): ResearchObservation;
  cancel(
    jobId: string,
    caller: ResearchCaller,
    requestId: string,
  ): Promise<ResearchObservation>;
  revise(
    request: ResearchFollowupRequest,
    caller: ResearchCaller,
  ): ResearchHandle;
  redoTask(
    request: ResearchRedoRequest,
    caller: ResearchCaller,
  ): Promise<ResearchControlResult>;
  cancelTask(
    request: ResearchCancelRequest,
    caller: ResearchCaller,
  ): Promise<CancelTaskResult>;
  review(
    request: ReviewResearchRequest,
    caller: ResearchCaller,
  ): StageReviewResult;
  control(
    input: ResearchControl,
    caller: ResearchCaller,
    requestId: string,
  ): Promise<ResearchControlResult>;
}
