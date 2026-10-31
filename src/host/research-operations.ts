import type {
  ArtifactCommitResult,
  RedoTaskResult,
} from "../contracts/runs.js";
import type { DecisionService } from "../services/decisions.js";
import type { DigestService } from "../services/digest/index.js";
import type { BoundCaller } from "./bindings.js";
import type {
  DispatchBridge,
  DispatchResult,
  StageDispatchResult,
} from "./dispatch.js";

export interface ResearchTaskRequest {
  runId: string;
  taskId: string;
  requestId: string;
}
export interface ResearchStageRequest {
  runId: string;
  stageId: string;
  requestId: string;
}
export interface ResearchFollowupRequest extends ResearchTaskRequest {
  message: string;
  resumeSearch: boolean;
}
export interface ResearchRedoRequest extends ResearchTaskRequest {
  reason: string | null;
}

export interface DispatchOperations {
  dispatchTask(
    request: ResearchTaskRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<DispatchResult>;
  dispatchStage(
    request: ResearchStageRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<StageDispatchResult>;
  followupTask(
    request: ResearchFollowupRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<DispatchResult>;
  redoTask(
    request: ResearchRedoRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<RedoTaskResult>;
}
export interface ServiceTaskOperations {
  makeDigest(
    request: ResearchTaskRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<ArtifactCommitResult>;
  decide(
    request: ResearchTaskRequest,
    caller: BoundCaller,
    signal: AbortSignal,
  ): Promise<ArtifactCommitResult>;
}
export type ResearchOperations = DispatchOperations & ServiceTaskOperations;

/** Requests and run permissions are established by the calling entry point. */
export function createDispatchOperations(
  bridge: Pick<
    DispatchBridge,
    "dispatch" | "dispatchStage" | "followup" | "redo"
  >,
): DispatchOperations {
  return {
    dispatchTask(request, caller, signal) {
      return bridge.dispatch(
        caller.agent,
        request.runId,
        request.taskId,
        request.requestId,
        signal,
      );
    },
    dispatchStage(request, caller, signal) {
      return bridge.dispatchStage(
        caller.agent,
        request.runId,
        request.stageId,
        request.requestId,
        signal,
      );
    },
    followupTask(request, caller, signal) {
      return bridge.followup(
        caller.agent,
        request.runId,
        request.taskId,
        request.message,
        request.requestId,
        request.resumeSearch,
        signal,
      );
    },
    redoTask(request, caller, signal) {
      signal.throwIfAborted();
      return bridge.redo(
        { runId: request.runId, identity: caller.agent.id },
        request.taskId,
        request.requestId,
        request.reason,
      );
    },
  };
}

export function createServiceTaskOperations(
  digests: Pick<DigestService, "makeDigest">,
  decisions: Pick<DecisionService, "decide">,
): ServiceTaskOperations {
  return {
    makeDigest(request, caller, signal) {
      return digests.makeDigest(
        { runId: request.runId, identity: caller.agent.id },
        request.taskId,
        request.requestId,
        signal,
      );
    },
    async decide(request, caller, signal) {
      return decisions.decide(
        { runId: request.runId, identity: caller.agent.id },
        request.taskId,
        request.requestId,
        signal,
      );
    },
  };
}
