import type { JsonValue } from "../contracts/cache.js";
import { ResearchError } from "../contracts/errors.js";
import type { ReplaySnapshot } from "../contracts/replay.js";
import type {
  OpenRunInput,
  ResearchRun,
  RunVersions,
  TaskInstructionSnapshot,
} from "../contracts/runs.js";
import type { ContentRef } from "../contracts/storage.js";
import { latestInstruction } from "./run-control.js";

export interface PreparedReplay {
  input: OpenRunInput;
  snapshot: ReplaySnapshot;
  instructions: Pick<
    TaskInstructionSnapshot,
    "taskId" | "version" | "instruction"
  >[];
}

function requireVersion(
  actual: string | undefined,
  expected: string,
  name: string,
): void {
  if (actual !== expected)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `Replay requires ${name} version ${expected}.`,
    );
}
function requireVersions(expected: RunVersions, available: RunVersions): void {
  requireVersion(available.plugin, expected.plugin, "plugin");
  requireVersion(available.mode, expected.mode, "mode");
  for (const group of [
    "prompts",
    "skills",
    "adapters",
    "normalization",
  ] as const)
    for (const [name, version] of Object.entries(expected[group]))
      requireVersion(available[group][name], version, `${group}.${name}`);
}

export function prepareReplay(
  source: ResearchRun,
  available: RunVersions,
  readInput: <T>(ref: ContentRef) => T,
): PreparedReplay {
  requireVersions(source.versions, available);
  const instructions: PreparedReplay["instructions"] = [];
  const tasks = source.tasks.map((task) => {
    const latest = task.attempts.at(-1);
    const attempt =
      latest === undefined || latest.status === "invalidated"
        ? null
        : latest.number;
    const instruction = latestInstruction(source, task.taskId);
    if (instruction !== undefined) {
      const saved = readInput<TaskInstructionSnapshot>(instruction.ref);
      instructions.push({
        taskId: task.taskId,
        version: saved.version,
        instruction: saved.instruction,
      });
    }
    return {
      taskId: task.taskId,
      attempt,
      outputRefs: task.outputRefs,
      evidenceRefs: source.evidence
        .filter(
          (entry) => entry.taskId === task.taskId && entry.attempt === attempt,
        )
        .map((entry) => ({
          runId: source.runId,
          evidenceId: entry.evidenceId,
          selector: "/data",
        })),
      memoryRefs: source.inputs
        .filter(
          (entry) =>
            entry.memory?.taskId === task.taskId &&
            entry.memory.attempt === attempt,
        )
        .map((entry) => entry.ref),
      instructionRef: instruction?.ref ?? null,
    };
  });
  return {
    input: {
      definition: source.definition,
      versions: source.versions,
      inputs: source.inputs
        .filter(
          (entry) =>
            entry.memory === undefined && entry.instruction === undefined,
        )
        .map((entry) => ({
          name: entry.name,
          content: readInput<JsonValue>(entry.ref),
        })),
    },
    snapshot: {
      sourceRunId: source.runId,
      sourceRevision: source.revision,
      tasks,
    },
    instructions,
  };
}
