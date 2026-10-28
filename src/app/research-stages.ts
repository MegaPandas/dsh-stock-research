import type { OpenRunInput } from "../contracts/runs.js";
import type { StageDefinition } from "../contracts/workflow.js";
import type { RunService } from "../services/runs.js";

export function researchStageFeedback(
  runs: RunService,
  runId: string,
  taskId: string,
) {
  const stage = runs
    .view({ runId })
    .stages?.find((entry) => entry.taskIds.includes(taskId));
  const review = stage?.latestReview;
  return review?.verdict === "rejected"
    ? {
        stageId: review.stageId,
        feedback: review.feedback,
        previousRefs: review.refs,
      }
    : undefined;
}

function stageId(taskId: string): string {
  if (taskId.startsWith("analysis.")) return "analysis";
  if (taskId.startsWith("debate."))
    return taskId.split(".").slice(0, 2).join(".");
  if (taskId.startsWith("risk.")) return "risk";
  return taskId;
}

/** Acceptance is added by the interactive application; portable task factories retain their original contract. */
export function attachResearchStages(input: OpenRunInput): OpenRunInput {
  const captured = structuredClone(input);
  const stages = new Map<string, StageDefinition>();
  for (const task of captured.definition.tasks) {
    if (
      task.executor.kind === "service" &&
      (task.executor.service === "finalize" ||
        (task.executor.service === "digest" &&
          captured.versions.prompts.digest === "12"))
    )
      continue;
    const id = stageId(task.id);
    let stage = stages.get(id);
    if (stage === undefined) {
      stage = { id, taskIds: [], beforeTasks: [] };
      stages.set(id, stage);
    }
    stage.taskIds.push(task.id);
  }
  for (const stage of stages.values())
    stage.beforeTasks = captured.definition.tasks
      .filter((task) => task.dependsOn.some((id) => stage.taskIds.includes(id)))
      .map((task) => task.id);
  captured.definition.stages = [...stages.values()];
  return captured;
}
