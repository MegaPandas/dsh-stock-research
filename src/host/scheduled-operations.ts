import type { Agent } from "@deepseek-ai/dsh-agent";
import { ExecutionStopped, ResearchError } from "../contracts/errors.js";
import type { SchedulerExecution } from "../services/scheduler/index.js";
import { authorizeRun, type SessionBindings } from "./bindings.js";
import type { DispatchBridge } from "./dispatch/index.js";
import type { ResearchOperations } from "./research-operations.js";

export type ScheduledResearchExecutor = (
  owner: Agent,
  runId: string,
  execution: SchedulerExecution,
  signal: AbortSignal,
) => Promise<void>;

/** Trusted scheduling uses the same claims, capacity and release owners as tools. */
export function createScheduledResearchExecutor(
  dispatch: Pick<DispatchBridge, "admitScheduled">,
  bindings: SessionBindings,
  operations: Pick<
    ResearchOperations,
    "dispatchTask" | "dispatchStage" | "makeDigest" | "decide" | "collectTask"
  >,
): ScheduledResearchExecutor {
  return async (owner, runId, execution, signal) => {
    signal.throwIfAborted();
    const caller = bindings.require(owner);
    if (caller.binding.kind !== "coordinator")
      throw new ResearchError(
        "ACCESS_DENIED",
        "Scheduling requires a coordinator binding.",
      );
    authorizeRun(caller.binding, runId);
    const targets = execution.kind === "stage" ? execution.tasks : [execution];
    await dispatch.admitScheduled(runId, targets, signal, async () => {
      try {
        if (execution.kind === "stage") {
          await operations.dispatchStage(
            {
              runId,
              stageId: execution.stageId,
              requestId: execution.requestId,
            },
            caller,
            signal,
          );
        } else {
          const request = {
            runId,
            taskId: execution.taskId,
            requestId: execution.requestId,
          };
          if (execution.executor.kind === "role")
            await operations.dispatchTask(request, caller, signal);
          else if (execution.executor.service === "digest")
            await operations.makeDigest(request, caller, signal);
          else if (execution.executor.service === "collection")
            await operations.collectTask(request, caller, signal);
          else await operations.decide(request, caller, signal);
        }
      } catch (cause) {
        if (!(cause instanceof ExecutionStopped)) throw cause;
      }
    });
  };
}
