import { randomUUID } from "node:crypto";
import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  AttemptTarget,
  BlockReasonInput,
  BlockRunResult,
  CancelRunResult,
  RecoverAttemptsResult,
  RedoTaskResult,
  ResearchRun,
  ResumeRunInput,
  ResumeRunResult,
  TaskFailure,
  TaskInstructionSnapshot,
  TaskOperation,
  TaskState,
} from "../contracts/runs.js";
import type { ContentWriter } from "../contracts/storage.js";
import { affectedTaskIds } from "./run-dependencies.js";

export function taskState(run: ResearchRun, taskId: string): TaskState {
  const task = run.tasks.find((task) => task.taskId === taskId);
  if (task === undefined)
    throw new ResearchError(
      "INVALID_INPUT",
      `Unknown task ${taskId} in run ${run.runId}.`,
    );
  return task;
}

export function currentAttempt(run: ResearchRun, operation: TaskOperation) {
  const task = taskState(run, operation.taskId);
  const attempt = task.attempts.at(-1);
  if (
    (run.status !== "active" && run.status !== "blocked") ||
    task.status !== "running" ||
    attempt?.number !== operation.attempt
  )
    throw new ResearchError(
      "STALE_ATTEMPT",
      `Task ${operation.taskId} attempt ${operation.attempt} is no longer running.`,
    );
  return { task, attempt };
}

function mutable(run: ResearchRun): void {
  if (run.status === "completed" || run.status === "cancelled")
    throw new ResearchError(
      "ACCESS_DENIED",
      `Run ${run.runId} is ${run.status}.`,
    );
}

export function latestInstruction(run: ResearchRun, taskId: string) {
  return run.inputs.findLast((input) => input.instruction?.taskId === taskId);
}

export function cancelRun(run: ResearchRun): CancelRunResult {
  mutable(run);
  const stopAttempts: AttemptTarget[] = [];
  for (const task of run.tasks) {
    if (task.status === "succeeded") continue;
    if (task.status === "running") {
      const attempt = task.attempts.at(-1)!;
      stopAttempts.push({ taskId: task.taskId, attempt: attempt.number });
      attempt.status = "cancelled";
      attempt.endedAt = run.updatedAt;
    }
    task.status = "cancelled";
  }
  run.status = "cancelled";
  return { runId: run.runId, status: "cancelled", stopAttempts };
}

export function blockRun(
  run: ResearchRun,
  reasons: readonly BlockReasonInput[],
): BlockRunResult {
  mutable(run);
  if (reasons.length === 0)
    throw new ResearchError(
      "INVALID_INPUT",
      "Blocking a run requires a reason.",
    );
  for (const reason of reasons) {
    if (reason.taskId === null) {
      if (reason.attempt !== null)
        throw new ResearchError(
          "INVALID_INPUT",
          "A run-wide reason cannot identify a task attempt.",
        );
    } else {
      const task = taskState(run, reason.taskId);
      const attempt = task.attempts.at(-1);
      if (
        reason.attempt !== null &&
        (attempt?.number !== reason.attempt ||
          attempt.status === "invalidated" ||
          attempt.status === "cancelled")
      )
        throw new ResearchError(
          "STALE_ATTEMPT",
          `Block reason refers to an inactive attempt of ${reason.taskId}.`,
        );
    }
  }
  const added = reasons.map((reason) => ({ ...reason, id: randomUUID() }));
  run.blockReasons.push(...added);
  run.status = "blocked";
  return {
    runId: run.runId,
    status: "blocked",
    reasonIds: added.map((reason) => reason.id),
  };
}

export function resumeRun(
  run: ResearchRun,
  input: ResumeRunInput,
  writer: ContentWriter,
): ResumeRunResult {
  mutable(run);
  const resolved = new Set(input.resolvedReasonIds);
  if (
    resolved.size !== input.resolvedReasonIds.length ||
    input.resolvedReasonIds.some(
      (id) => !run.blockReasons.some((reason) => reason.id === id),
    )
  )
    throw new ResearchError(
      "INVALID_INPUT",
      "Resolved reasons must be distinct current reason identifiers.",
    );
  const revised = new Set<string>();
  const planned = input.instructions.map((update) => {
    if (revised.has(update.taskId))
      throw new ResearchError(
        "INVALID_INPUT",
        `Duplicate instruction update for ${update.taskId}.`,
      );
    revised.add(update.taskId);
    const task = taskState(run, update.taskId);
    if (task.status !== "pending" && task.status !== "failed")
      throw new ResearchError(
        "TASK_NOT_READY",
        `Instructions for ${update.taskId} require a pending or failed task.`,
      );
    const definition = run.definition.tasks.find(
      (task) => task.id === update.taskId,
    )!;
    const version = definition.instructionVersion + 1;
    if (!Number.isFinite(version) || version <= definition.instructionVersion)
      throw new ResearchError(
        "INVALID_INPUT",
        `Instruction version cannot advance for ${update.taskId}.`,
      );
    return { update, definition, version };
  });
  const baseDefinition = run.definitionRef;
  for (const { update, definition, version } of planned) {
    const previous = latestInstruction(run, update.taskId)?.ref ?? null;
    const content: TaskInstructionSnapshot = {
      ...update,
      version,
      previous,
      baseDefinition,
      recordedAt: run.updatedAt,
    };
    const ref = writer.input(() => content);
    run.inputs.push({
      name: `instruction:${update.taskId}`,
      ref,
      instruction: { taskId: update.taskId, version },
    });
    definition.instructionVersion = version;
  }
  if (input.instructions.length > 0)
    run.definitionRef = writer.input(() => run.definition);
  run.blockReasons = run.blockReasons.filter(
    (reason) => !resolved.has(reason.id),
  );
  const status = run.blockReasons.length === 0 ? "active" : "blocked";
  run.status = status;
  return {
    runId: run.runId,
    status,
    revisedTasks: [...revised],
    remainingReasonIds: run.blockReasons.map((reason) => reason.id),
  };
}

export function redoRun(
  run: ResearchRun,
  taskId: string,
  readArtifact: (ref: ArtifactRef) => ArtifactVersion,
): RedoTaskResult {
  mutable(run);
  taskState(run, taskId);
  const affected = affectedTaskIds(run, taskId, readArtifact);
  const stopAttempts: AttemptTarget[] = [];
  const invalidatedRefs: ArtifactRef[] = [];
  const invalidatedAttempts = new Map<string, number>();
  for (const task of run.tasks) {
    if (!affected.has(task.taskId)) continue;
    invalidatedRefs.push(...task.outputRefs);
    const attempt = task.attempts.at(-1);
    if (attempt !== undefined) {
      invalidatedAttempts.set(task.taskId, attempt.number);
      if (task.status === "running") {
        stopAttempts.push({ taskId: task.taskId, attempt: attempt.number });
        attempt.endedAt = run.updatedAt;
      }
      attempt.status = "invalidated";
    }
    task.status = "pending";
    task.outputRefs = [];
  }
  run.blockReasons = run.blockReasons.filter(
    (reason) =>
      reason.taskId === null ||
      reason.attempt === null ||
      invalidatedAttempts.get(reason.taskId) !== reason.attempt,
  );
  const status = run.blockReasons.length === 0 ? "active" : "blocked";
  run.status = status;
  return {
    runId: run.runId,
    taskId,
    status,
    affectedTasks: run.tasks
      .filter((task) => affected.has(task.taskId))
      .map((task) => task.taskId),
    stopAttempts,
    invalidatedRefs,
  };
}

export function recoverAttempts(
  run: ResearchRun,
  targets: readonly AttemptTarget[],
  failure: TaskFailure,
): RecoverAttemptsResult {
  mutable(run);
  const failedAttempts: AttemptTarget[] = [];
  for (const target of targets) {
    const task = taskState(run, target.taskId);
    if (task.status !== "running") continue;
    const attempt = task.attempts.at(-1)!;
    if (attempt.number !== target.attempt) continue;
    task.status = "failed";
    attempt.status = "failed";
    attempt.failure = failure;
    attempt.endedAt = run.updatedAt;
    failedAttempts.push(target);
  }
  return { runId: run.runId, failedAttempts };
}
