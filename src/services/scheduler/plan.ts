import type { AttemptTarget, RunView } from "../../contracts/runs.js";
import type { RunDefinition } from "../../contracts/workflow.js";
import type { SchedulerExecution } from "./types.js";

export function executionTasks(
  execution: SchedulerExecution,
): readonly AttemptTarget[] {
  return execution.kind === "stage" ? execution.tasks : [execution];
}

export function readyExecutions(
  definition: RunDefinition,
  view: RunView,
  reserved: ReadonlyMap<string, number>,
): SchedulerExecution[] {
  const states = new Map(view.tasks.map((task) => [task.taskId, task]));
  const ready = new Set(view.readyTasks);
  const selected = new Map(reserved);
  const executions: SchedulerExecution[] = [];
  for (const task of definition.tasks) {
    if (
      states.get(task.id)!.status !== "pending" ||
      !ready.has(task.id) ||
      selected.get(task.id) === states.get(task.id)!.attempt + 1
    )
      continue;
    const stage = definition.stages?.find(
      (stage) =>
        stage.dispatch === "together" && stage.taskIds.includes(task.id),
    );
    if (
      stage !== undefined &&
      stage.taskIds.filter((id) => ready.has(id)).length > 1
    ) {
      if (
        !stage.taskIds.every(
          (id) =>
            ready.has(id) &&
            states.get(id)!.status === "pending" &&
            selected.get(id) !== states.get(id)!.attempt + 1,
        )
      )
        continue;
      const tasks = stage.taskIds.map((taskId) => ({
        taskId,
        attempt: states.get(taskId)!.attempt + 1,
      }));
      executions.push({
        kind: "stage",
        stageId: stage.id,
        tasks,
        requestId: JSON.stringify(["scheduler", "stage", stage.id, tasks]),
      });
      for (const { taskId, attempt } of tasks) selected.set(taskId, attempt);
    } else {
      const attempt = states.get(task.id)!.attempt + 1;
      executions.push({
        kind: "task",
        taskId: task.id,
        attempt,
        executor: task.executor,
        requestId: JSON.stringify(["scheduler", "task", task.id, attempt]),
      });
      selected.set(task.id, attempt);
    }
  }
  return executions;
}
