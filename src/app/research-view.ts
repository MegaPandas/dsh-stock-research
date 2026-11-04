import type { RunView } from "../contracts/runs.js";
import type {
  ResearchContext,
  ResearchObservation,
} from "./research-actions.js";

/** Model-facing state; fixed report references are supplied by the report catalog. */
export function researchRunView(view: RunView) {
  return {
    runId: view.runId,
    scope: view.scope,
    mode: view.mode,
    status: view.status,
    tasks: view.tasks.map(({ taskId, status, attempt, failure }) => ({
      taskId,
      status,
      attempt,
      ...(failure === null ? {} : { failure }),
    })),
    blockReasons: view.blockReasons,
    stages: (view.stages ?? []).map((stage) => ({
      id: stage.id,
      taskIds: stage.taskIds,
      readyForReview: stage.readyForReview,
      accepted: stage.accepted,
      refs: stage.readyForReview && !stage.accepted ? stage.refs : [],
      ...(!stage.accepted && stage.latestReview?.verdict === "rejected"
        ? { feedback: stage.latestReview.feedback }
        : {}),
    })),
  };
}

export type ResearchRunView = ReturnType<typeof researchRunView>;

export function researchContextView(context: ResearchContext) {
  return { ...context, view: researchRunView(context.view) };
}

export function researchObservationView({
  view,
  ...observation
}: ResearchObservation) {
  return {
    ...observation,
    ...(view === undefined ? {} : { view: researchRunView(view) }),
  };
}

export type ResearchObservationView = ReturnType<
  typeof researchObservationView
>;
