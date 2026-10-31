import type { CollectionFailure } from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import type {
  AttemptTarget,
  ResumeRunInput,
  RunView,
  StageReviewInput,
} from "../contracts/runs.js";
import type { RunDefinition, TaskDefinition } from "../contracts/workflow.js";
import type { ResearchCaller } from "../host/bindings.js";

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
  | { kind: "redo"; runId: string; taskId: string; reason: string | null }
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
  | { kind: "continuation"; context: ResearchContext };

/** Inputs are validated by adapters; caller identity comes from the host. */
export interface ResearchActions {
  start(
    request: StartResearchRequest,
    caller: ResearchCaller,
  ): Promise<ResearchContext>;
  review(request: ReviewResearchRequest, caller: ResearchCaller): RunView;
  control(
    input: ResearchControl,
    caller: ResearchCaller,
    requestId: string,
  ): Promise<ResearchControlResult>;
}
