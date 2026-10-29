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

/** Acceptance is added by the interactive application; portable task factories retain their original contract. */
export function attachResearchStages(
  input: OpenRunInput,
  stages: readonly StageDefinition[],
): OpenRunInput {
  const captured = structuredClone(input);
  captured.definition.stages = structuredClone([...stages]);
  return captured;
}
