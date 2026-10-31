import { ResearchError } from "../contracts/errors.js";
import type { RunLifecycle, RunReader } from "../contracts/run-access.js";
import type { RunOperation } from "../contracts/runs.js";

export function dispatchClaimRequestId(requestId: string): string {
  return JSON.stringify(["dispatch", requestId]);
}

/** Read-only dispatch eligibility; claims and durable state belong to the run owner. */
export class RunDispatchPlanner {
  constructor(
    private readonly runs: Pick<RunReader, "readDefinition" | "view"> &
      Pick<RunLifecycle, "hasClaimReceipt">,
  ) {}

  assertIndividual(
    operation: RunOperation,
    taskId: string,
    requestId: string,
  ): void {
    if (this.runs.hasClaimReceipt(operation, dispatchClaimRequestId(requestId)))
      return;
    const { runId } = operation;
    const definition = this.runs.readDefinition(runId);
    const stage = definition.stages?.find((entry) =>
      entry.taskIds.includes(taskId),
    );
    if (stage?.dispatch !== "together") return;
    const ready = new Set(this.runs.view({ runId }).readyTasks);
    if (stage.taskIds.filter((id) => ready.has(id)).length > 1)
      throw new ResearchError(
        "INVALID_INPUT",
        `This stage requires ready roles to start together. Use stock_dispatch_stage with stageId=${stage.id}.`,
      );
  }

  stageTasks(runId: string, stageId: string): readonly string[] {
    const definition = this.runs.readDefinition(runId);
    const stage = definition.stages?.find((entry) => entry.id === stageId);
    if (stage === undefined)
      throw new ResearchError("INVALID_INPUT", "Unknown research stage.");
    const definitions = stage.taskIds.map((id) =>
      definition.tasks.find((task) => task.id === id)!,
    );
    if (definitions.some((task) => task.executor.kind !== "role"))
      throw new ResearchError(
        "INVALID_INPUT",
        "Only role stages can be dispatched; use the service tool for summaries and finalization.",
      );
    return stage.taskIds;
  }

  stageRequests(
    operation: RunOperation,
    stageId: string,
    taskIds: readonly string[],
    requestId: string,
  ): { taskId: string; requestId: string }[] {
    const ready = this.runs.view(operation).readyTasks;
    const requests = taskIds.map((taskId) => ({
      taskId,
      requestId: JSON.stringify(["stage", stageId, requestId, taskId]),
    }));
    const replays = requests.map((request) =>
      this.runs.hasClaimReceipt(
        operation,
        dispatchClaimRequestId(request.requestId),
      ),
    );
    if (replays.some(Boolean) && !replays.every(Boolean))
      throw new ResearchError(
        "STALE_ATTEMPT",
        "The previous batch was interrupted while claiming tasks. Confirm interruption and recover before dispatching a new batch.",
      );
    if (!replays.every(Boolean)) this.assertStageReady(taskIds, ready);
    return requests;
  }

  private assertStageReady(
    taskIds: readonly string[],
    readyTasks: readonly string[],
  ): void {
    const ready = new Set(readyTasks);
    if (!taskIds.every((taskId) => ready.has(taskId)))
      throw new ResearchError(
        "TASK_NOT_READY",
        "All roles in the stage must be ready for batch dispatch; use stock_dispatch_task for a single-sided revision.",
      );
  }
}
