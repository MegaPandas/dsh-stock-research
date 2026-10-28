import { isDeepStrictEqual } from "node:util";
import { ResearchError } from "../contracts/errors.js";
import type { ResearchRun } from "../contracts/runs.js";
import type { RunDefinition } from "../contracts/workflow.js";
import { validateRunDefinition } from "./definition.js";

const ARTIFACT_KINDS = [
  "analysis",
  "debate",
  "risk",
  "plan",
  "digest",
  "decision_draft",
  "decision",
  "report",
];

function invalid(field: string): never {
  throw new ResearchError(
    "STORAGE_FAILED",
    `Invalid stored run state: ${field}.`,
  );
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function string(value: unknown, field: string): void {
  if (typeof value !== "string") invalid(field);
}
function nullableString(value: unknown, field: string): void {
  if (value !== null) string(value, field);
}
function positive(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid(field);
}
function number(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
}
function oneOf(
  value: unknown,
  choices: readonly string[],
  field: string,
): void {
  if (typeof value !== "string" || !choices.includes(value)) invalid(field);
}
function strings(value: unknown, field: string): void {
  for (const item of array(value, field)) string(item, field);
}
function contentRef(value: unknown, field: string): void {
  const ref = object(value, field);
  oneOf(ref.kind, ["input", "evidence", "artifact"], `${field}.kind`);
  string(ref.id, `${field}.id`);
  if (ref.kind === "artifact") positive(ref.revision, `${field}.revision`);
}
function inputRef(value: unknown, field: string): void {
  contentRef(value, field);
  if (object(value, field).kind !== "input")
    invalid(`${field} must reference an input`);
}
function artifactRef(value: unknown, field: string): void {
  const ref = object(value, field);
  string(ref.runId, `${field}.runId`);
  string(ref.artifactId, `${field}.artifactId`);
  positive(ref.revision, `${field}.revision`);
}
function artifactRefs(value: unknown, field: string): void {
  for (const ref of array(value, field)) artifactRef(ref, field);
}
function attemptTargets(value: unknown, field: string): void {
  for (const entry of array(value, field)) {
    const target = object(entry, field);
    string(target.taskId, `${field}.taskId`);
    positive(target.attempt, `${field}.attempt`);
  }
}
function failure(value: unknown, field: string): void {
  const reason = object(value, field);
  string(reason.code, `${field}.code`);
  string(reason.message, `${field}.message`);
}
function scope(value: unknown, field: string): void {
  const scope = object(value, field);
  const security = object(scope.security, `${field}.security`);
  for (const key of ["id", "symbol", "exchange", "currency", "timeZone"])
    string(security[key], `${field}.security.${key}`);
  oneOf(security.market, ["US", "CN"], `${field}.security.market`);
  string(scope.date, `${field}.date`);
  string(scope.cutoff, `${field}.cutoff`);
}
function definition(value: unknown): RunDefinition {
  const definition = object(value, "definition");
  scope(definition.scope, "definition.scope");
  oneOf(definition.mode, ["quick", "deep"], "definition.mode");
  for (const value of array(definition.tasks, "definition.tasks")) {
    const task = object(value, "definition task");
    string(task.id, "definition task.id");
    const executor = object(task.executor, "definition task.executor");
    oneOf(executor.kind, ["role", "service"], "definition task.executor.kind");
    if (executor.kind === "role") {
      oneOf(
        executor.role,
        ["analyst", "discussion", "manager"],
        "definition task.executor.role",
      );
      string(executor.specialty, "definition task.executor.specialty");
    } else
      oneOf(
        executor.service,
        ["digest", "finalize"],
        "definition task.executor.service",
      );
    strings(task.dependsOn, "definition task.dependsOn");
    strings(task.inputTasks, "definition task.inputTasks");
    for (const kind of array(task.outputKinds, "definition task.outputKinds"))
      oneOf(kind, ARTIFACT_KINDS, "definition task.outputKinds");
    number(task.instructionVersion, "definition task.instructionVersion");
    for (const value of array(
      task.dataRequirements,
      "definition task.dataRequirements",
    )) {
      const requirement = object(value, "data requirement");
      oneOf(
        requirement.dataset,
        ["market", "fundamentals", "macro", "returns", "research"],
        "data requirement.dataset",
      );
      strings(requirement.fields, "data requirement.fields");
      if (typeof requirement.requiredForDecision !== "boolean")
        invalid("data requirement.requiredForDecision");
    }
  }
  if (definition.stages !== undefined) {
    for (const value of array(definition.stages, "definition.stages")) {
      const stage = object(value, "stage");
      string(stage.id, "stage.id");
      strings(stage.taskIds, "stage.taskIds");
      strings(stage.beforeTasks, "stage.beforeTasks");
    }
  }
  const result = definition as unknown as RunDefinition;
  try {
    validateRunDefinition(result);
  } catch (cause) {
    throw new ResearchError(
      "STORAGE_FAILED",
      "Invalid stored run task graph.",
      { cause },
    );
  }
  return result;
}
function attempt(value: unknown): void {
  const attempt = object(value, "attempt");
  positive(attempt.number, "attempt.number");
  oneOf(
    attempt.status,
    ["running", "succeeded", "failed", "invalidated", "cancelled"],
    "attempt.status",
  );
  artifactRefs(attempt.inputRefs, "attempt.inputRefs");
  artifactRefs(attempt.outputRefs, "attempt.outputRefs");
  number(attempt.instructionVersion, "attempt.instructionVersion");
  if (attempt.instructionRef !== undefined)
    inputRef(attempt.instructionRef, "attempt.instructionRef");
  nullableString(attempt.sessionId, "attempt.sessionId");
  string(attempt.startedAt, "attempt.startedAt");
  nullableString(attempt.endedAt, "attempt.endedAt");
  if (attempt.failure !== null) failure(attempt.failure, "attempt.failure");
}
function stageReview(value: unknown, field: string): void {
  const review = object(value, field);
  string(review.stageId, `${field}.stageId`);
  oneOf(review.verdict, ["accepted", "rejected"], `${field}.verdict`);
  string(review.feedback, `${field}.feedback`);
  artifactRefs(review.refs, `${field}.refs`);
  string(review.identity, `${field}.identity`);
  string(review.recordedAt, `${field}.recordedAt`);
  string(review.requestId, `${field}.requestId`);
}
function receipt(value: unknown): void {
  const receipt = object(value, "receipt");
  string(receipt.scope, "receipt.scope");
  string(receipt.requestId, "receipt.requestId");
  oneOf(
    receipt.action,
    [
      "open",
      "claim",
      "dispatch_stage",
      "commit_artifact",
      "finalize",
      "fail_attempt",
      "cancel",
      "block",
      "resume",
      "redo",
      "recover_attempts",
      "record_evidence",
      "record_memory_input",
      "replay_evidence",
      "replay_memory_input",
      "review_stage",
    ],
    "receipt.action",
  );
  inputRef(receipt.request, "receipt.request");
  const result = object(receipt.result, "receipt.result");
  string(result.runId, "receipt.result.runId");
  if (
    receipt.action === "claim" ||
    receipt.action === "commit_artifact" ||
    receipt.action === "finalize" ||
    receipt.action === "fail_attempt"
  ) {
    string(result.taskId, "receipt.result.taskId");
    positive(result.attempt, "receipt.result.attempt");
  }
  if (receipt.action === "claim") {
    artifactRefs(result.inputRefs, "receipt.result.inputRefs");
    number(result.instructionVersion, "receipt.result.instructionVersion");
    if (result.instructionRef !== undefined)
      inputRef(result.instructionRef, "receipt.result.instructionRef");
  } else if (
    receipt.action === "commit_artifact" ||
    receipt.action === "finalize"
  ) {
    artifactRefs(result.refs, "receipt.result.refs");
  } else if (receipt.action === "cancel") {
    oneOf(result.status, ["cancelled"], "receipt.result.status");
    attemptTargets(result.stopAttempts, "receipt.result.stopAttempts");
  } else if (receipt.action === "block") {
    oneOf(result.status, ["blocked"], "receipt.result.status");
    strings(result.reasonIds, "receipt.result.reasonIds");
  } else if (receipt.action === "resume") {
    oneOf(result.status, ["active", "blocked"], "receipt.result.status");
    strings(result.revisedTasks, "receipt.result.revisedTasks");
    strings(result.remainingReasonIds, "receipt.result.remainingReasonIds");
  } else if (receipt.action === "redo") {
    string(result.taskId, "receipt.result.taskId");
    oneOf(result.status, ["active", "blocked"], "receipt.result.status");
    strings(result.affectedTasks, "receipt.result.affectedTasks");
    attemptTargets(result.stopAttempts, "receipt.result.stopAttempts");
    artifactRefs(result.invalidatedRefs, "receipt.result.invalidatedRefs");
  } else if (receipt.action === "recover_attempts") {
    attemptTargets(result.failedAttempts, "receipt.result.failedAttempts");
  } else if (receipt.action === "review_stage") {
    stageReview(result.review, "receipt.result.review");
  } else if (
    receipt.action === "record_evidence" ||
    receipt.action === "replay_evidence"
  ) {
    string(result.evidenceId, "receipt.result.evidenceId");
    string(result.selector, "receipt.result.selector");
  } else if (
    receipt.action === "record_memory_input" ||
    receipt.action === "replay_memory_input"
  ) {
    inputRef(result.inputRef, "receipt.result.inputRef");
  }
}

export function assertStoredRun(value: unknown): asserts value is ResearchRun {
  const run = object(value, "run");
  if (run.stateVersion !== 3)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `Unsupported run state version: ${String(run.stateVersion)}`,
    );
  if (run.lineage !== null) {
    const lineage = object(run.lineage, "lineage");
    string(lineage.sourceRunId, "lineage.sourceRunId");
    if (lineage.sourceRunId === run.runId)
      invalid("lineage cannot reference the same run");
    positive(lineage.sourceRevision, "lineage.sourceRevision");
    inputRef(lineage.snapshotRef, "lineage.snapshotRef");
  }
  const savedDefinition = definition(run.definition);
  scope(run.scope, "scope");
  oneOf(run.mode, ["quick", "deep"], "mode");
  if (
    !isDeepStrictEqual(run.scope, savedDefinition.scope) ||
    run.mode !== savedDefinition.mode
  )
    invalid("scope or mode differs from definition");
  contentRef(run.definitionRef, "definitionRef");
  for (const value of array(run.inputs, "inputs")) {
    const input = object(value, "input");
    string(input.name, "input.name");
    contentRef(input.ref, "input.ref");
    if (input.instruction !== undefined) {
      const instruction = object(input.instruction, "input.instruction");
      string(instruction.taskId, "input.instruction.taskId");
      number(instruction.version, "input.instruction.version");
      inputRef(input.ref, "instruction input.ref");
    }
    if (input.memory !== undefined) {
      const memory = object(input.memory, "input.memory");
      string(memory.taskId, "input.memory.taskId");
      positive(memory.attempt, "input.memory.attempt");
      string(memory.callId, "input.memory.callId");
      inputRef(input.ref, "memory input.ref");
    }
  }
  oneOf(run.status, ["active", "blocked", "completed", "cancelled"], "status");
  const taskIds = new Set(savedDefinition.tasks.map((task) => task.id));
  for (const value of array(run.tasks, "tasks")) {
    const task = object(value, "task");
    if (typeof task.taskId !== "string" || !taskIds.delete(task.taskId))
      invalid("task.taskId");
    oneOf(
      task.status,
      ["pending", "running", "succeeded", "failed", "cancelled"],
      "task.status",
    );
    const attempts = array(task.attempts, "task.attempts");
    for (let index = 0; index < attempts.length; index++) {
      const value = attempts[index];
      attempt(value);
      if (object(value, "attempt").number !== index + 1)
        invalid("attempt numbers must follow their recorded order");
    }
    artifactRefs(task.outputRefs, "task.outputRefs");
    const latest = attempts.at(-1);
    if (
      task.status === "running" ||
      task.status === "succeeded" ||
      task.status === "failed"
    ) {
      if (
        latest === undefined ||
        object(latest, "attempt").status !== task.status
      )
        invalid("task status differs from its current attempt");
    }
    if (task.status === "succeeded") {
      if (
        !isDeepStrictEqual(
          task.outputRefs,
          object(latest, "attempt").outputRefs,
        )
      )
        invalid("task outputs differ from its current attempt");
    } else if (array(task.outputRefs, "task.outputRefs").length !== 0)
      invalid("unfinished task has current outputs");
    if (
      task.status !== "running" &&
      latest !== undefined &&
      object(latest, "attempt").status === "running"
    )
      invalid("unfinished attempt has no running task");
  }
  if (taskIds.size !== 0) invalid("missing task state");
  for (const value of array(run.artifacts, "artifacts")) {
    const artifact = object(value, "artifact");
    artifactRef(artifact.ref, "artifact.ref");
    oneOf(artifact.kind, ARTIFACT_KINDS, "artifact.kind");
    string(artifact.taskId, "artifact.taskId");
    positive(artifact.attempt, "artifact.attempt");
    string(artifact.createdAt, "artifact.createdAt");
  }
  if (savedDefinition.stages !== undefined) {
    for (const value of array(run.stageReviews, "stageReviews")) {
      stageReview(value, "stage review");
      const review = object(value, "stage review");
      if (!savedDefinition.stages.some((stage) => stage.id === review.stageId))
        invalid("stage review refers to an unknown stage");
      for (const ref of array(review.refs, "stage review.refs"))
        if (object(ref, "stage review ref").runId !== run.runId)
          invalid("stage review output belongs to another run");
    }
  } else if (run.stageReviews !== undefined)
    invalid("stage reviews require a staged definition");
  for (const entry of array(run.evidence, "evidence")) {
    const evidence = object(entry, "evidence entry");
    string(evidence.evidenceId, "evidence entry.evidenceId");
    string(evidence.taskId, "evidence entry.taskId");
    positive(evidence.attempt, "evidence entry.attempt");
    string(evidence.callId, "evidence entry.callId");
  }
  let openReceipts = 0;
  for (const value of array(run.receipts, "receipts")) {
    receipt(value);
    const item = object(value, "receipt");
    const result = object(item.result, "receipt.result");
    if (result.runId !== run.runId)
      invalid("receipt result belongs to another run");
    if (item.action === "open") openReceipts++;
  }
  if (openReceipts !== 1) invalid("exactly one open receipt is required");
  const versions = object(run.versions, "versions");
  string(versions.plugin, "versions.plugin");
  string(versions.mode, "versions.mode");
  for (const key of ["prompts", "skills", "adapters", "normalization"])
    for (const value of Object.values(object(versions[key], `versions.${key}`)))
      string(value, `versions.${key}`);
  string(run.createdAt, "createdAt");
  string(run.updatedAt, "updatedAt");
  nullableString(run.completedAt, "completedAt");
  for (const value of array(run.blockReasons, "blockReasons")) {
    const reason = object(value, "block reason");
    string(reason.id, "block reason.id");
    nullableString(reason.taskId, "block reason.taskId");
    if (reason.attempt !== null)
      positive(reason.attempt, "block reason.attempt");
    failure(reason, "block reason");
  }
}
