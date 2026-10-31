import { ResearchError } from "../contracts/errors.js";
import type { RunReader } from "../contracts/run-access.js";

/** Read-only dispatch eligibility; claims and durable state belong to the run owner. */
export class RunDispatchPlanner {
  constructor(
    private readonly runs: Pick<RunReader, "readDefinition" | "view">,
  ) {}

  assertIndividual(runId: string, taskId: string): void {
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

  assertStageReady(
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
