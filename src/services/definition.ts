import type { ArtifactKind } from "../contracts/artifacts.js";
import { ResearchError } from "../contracts/errors.js";
import type { RunDefinition, TaskDefinition } from "../contracts/workflow.js";

const ROLE_OUTPUTS = {
  analyst: ["analysis"],
  discussion: ["debate", "risk"],
  manager: ["plan", "decision_draft"],
} as const satisfies Record<string, readonly ArtifactKind[]>;
const SERVICE_OUTPUTS = {
  digest: ["digest"],
  finalize: ["decision", "report"],
} as const satisfies Record<string, readonly ArtifactKind[]>;

function invalid(taskId: string, reason: string): never {
  throw new ResearchError("INVALID_INPUT", `Task ${taskId}: ${reason}`);
}

function checkOutputs(task: TaskDefinition): void {
  const executor = task.executor;
  const allowed: readonly ArtifactKind[] =
    executor.kind === "role"
      ? ROLE_OUTPUTS[executor.role]
      : SERVICE_OUTPUTS[executor.service];
  if (task.outputKinds.length === 0)
    invalid(task.id, "at least one output kind is required.");
  const outputs = new Set(task.outputKinds);
  if (outputs.size !== task.outputKinds.length)
    invalid(task.id, "output kinds must be unique.");
  for (const kind of outputs)
    if (!allowed.includes(kind))
      invalid(task.id, `output kind ${kind} does not match its executor.`);
  if (
    executor.kind === "service" &&
    executor.service === "finalize" &&
    outputs.size !== allowed.length
  )
    invalid(task.id, "finalize must publish both decision and report.");
  if (task.valuation !== undefined) {
    const requiredKind =
      task.valuation === "research" ? "analysis" : "decision_draft";
    if (executor.kind !== "role" || !outputs.has(requiredKind))
      invalid(
        task.id,
        `valuation ${task.valuation} requires ${requiredKind} output.`,
      );
  }
}

export function validateRunDefinition(definition: RunDefinition): void {
  const tasks = new Map<string, TaskDefinition>();
  for (const task of definition.tasks) {
    if (tasks.has(task.id)) invalid(task.id, "duplicate identifier.");
    tasks.set(task.id, task);
  }
  for (const task of definition.tasks) {
    checkOutputs(task);
    const dependencies = new Set(task.dependsOn);
    if (dependencies.size !== task.dependsOn.length)
      invalid(task.id, "dependencies must be unique.");
    for (const dependency of dependencies)
      if (!tasks.has(dependency))
        invalid(task.id, `dependency ${dependency} does not exist.`);
    if (new Set(task.inputTasks).size !== task.inputTasks.length)
      invalid(task.id, "input tasks must be unique.");
    for (const input of task.inputTasks)
      if (!dependencies.has(input))
        invalid(task.id, `input ${input} is not a dependency.`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stageIds = new Set<string>();
  const stagedTasks = new Set<string>();
  for (const stage of definition.stages ?? []) {
    if (stage.id.length === 0 || stageIds.has(stage.id))
      throw new ResearchError(
        "INVALID_INPUT",
        "Stage identifiers must be nonempty and unique.",
      );
    stageIds.add(stage.id);
    if (
      stage.taskIds.length === 0 ||
      new Set(stage.taskIds).size !== stage.taskIds.length
    )
      throw new ResearchError(
        "INVALID_INPUT",
        `Stage ${stage.id} requires distinct tasks.`,
      );
    for (const id of stage.taskIds) {
      if (!tasks.has(id) || stagedTasks.has(id))
        invalid(id, "stage task must exist and belong to one stage.");
      stagedTasks.add(id);
      if (
        stage.dispatch === "together" &&
        tasks.get(id)!.executor.kind !== "role"
      )
        invalid(id, "together dispatch requires role tasks.");
    }
    if (new Set(stage.beforeTasks).size !== stage.beforeTasks.length)
      throw new ResearchError(
        "INVALID_INPUT",
        `Stage ${stage.id} gates must be distinct.`,
      );
    for (const id of stage.beforeTasks) {
      if (!tasks.has(id) || stage.taskIds.includes(id))
        invalid(id, "stage gate must name another existing task.");
      if (
        !stage.taskIds.every((taskId) =>
          tasks.get(id)!.dependsOn.includes(taskId),
        )
      )
        invalid(
          id,
          "stage gate must depend on every task reviewed by that stage.",
        );
    }
  }
  function visit(task: TaskDefinition): void {
    if (visiting.has(task.id)) invalid(task.id, "dependency cycle.");
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const id of task.dependsOn) visit(tasks.get(id)!);
    visiting.delete(task.id);
    visited.add(task.id);
  }
  for (const task of definition.tasks) visit(task);
}
