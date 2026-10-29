import { ResearchError } from "../contracts/errors.js";
import type { AttemptTarget, ResumeRunInput } from "../contracts/runs.js";
import {
  object,
  objectSchema,
  positive,
  stringSchema,
  text,
} from "../tools/parameters.js";

export type RunCommand =
  | { kind: "status"; runId: string }
  | { kind: "cancel"; runId: string }
  | { kind: "replay"; runId: string }
  | { kind: "resume"; runId: string; input: ResumeRunInput }
  | { kind: "redo"; runId: string; taskId: string; reason: string | null }
  | { kind: "recover"; runId: string; attempts: AttemptTarget[] };
export type RunCommandKind = RunCommand["kind"];

const resumeInputSchema = objectSchema({
  resolvedReasonIds: {
    type: "array",
    items: stringSchema,
    description:
      "Resolved blockReasons.id values from run_view; use [] when there are none to clear.",
  },
  instructions: {
    type: "array",
    items: objectSchema({ taskId: stringSchema, instruction: stringSchema }),
    description:
      "New instructions for pending or failed tasks only; use [] when no revisions are needed.",
  },
});
const attemptsSchema = {
  type: "array",
  items: objectSchema({ taskId: stringSchema, attempt: { type: "integer" } }),
} as const;
export type ResearchControlKind = Exclude<RunCommandKind, "status" | "redo">;
const controlFields = { runId: stringSchema, requestId: stringSchema };
export const runControlParameters = {
  resume: objectSchema({ ...controlFields, input: resumeInputSchema }),
  recover: objectSchema({ ...controlFields, attempts: attemptsSchema }),
  cancel: objectSchema(controlFields),
  replay: objectSchema(controlFields),
} satisfies Record<ResearchControlKind, JsonSchemaNode>;

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value))
    throw new ResearchError("INVALID_INPUT", `${field} requires an array.`);
  return value;
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new ResearchError("INVALID_INPUT", "Invalid command JSON.", {
      cause,
    });
  }
}

function resumeInput(value: unknown): ResumeRunInput {
  const item = object(value, ["resolvedReasonIds", "instructions"]);
  return {
    resolvedReasonIds: array(item.resolvedReasonIds, "resolvedReasonIds").map(
      (value) => text(value, "reasonId"),
    ),
    instructions: array(item.instructions, "instructions").map((value) => {
      const update = object(value, ["taskId", "instruction"]);
      return {
        taskId: text(update.taskId, "taskId"),
        instruction: text(update.instruction, "instruction"),
      };
    }),
  };
}

function attempts(value: unknown): AttemptTarget[] {
  return array(value, "attempts").map((value) => {
    const item = object(value, ["taskId", "attempt"]);
    return {
      taskId: text(item.taskId, "taskId"),
      attempt: positive(item.attempt, "attempt"),
    };
  });
}

export function parseRunControl(
  kind: ResearchControlKind,
  value: unknown,
): {
  command: RunCommand;
  requestId: string;
} {
  const actionFields =
    kind === "resume" ? ["input"] : kind === "recover" ? ["attempts"] : [];
  const item = object(value, ["runId", "requestId", ...actionFields]);
  const runId = text(item.runId, "runId");
  const requestId = text(item.requestId, "requestId");
  let command: RunCommand;
  switch (kind) {
    case "resume":
      command = { kind, runId, input: resumeInput(item.input) };
      break;
    case "recover":
      command = { kind, runId, attempts: attempts(item.attempts) };
      break;
    case "cancel":
    case "replay":
      command = { kind, runId };
      break;
  }
  return { command, requestId };
}
export function parseRunCommand(
  kind: RunCommandKind,
  rawInput: string,
): RunCommand {
  if (kind === "status" || kind === "cancel" || kind === "replay") {
    const match = /^\s*(\S+)\s*$/.exec(rawInput);
    if (match === null)
      throw new ResearchError("INVALID_INPUT", `Usage: /stock-${kind} <runId>`);
    return { kind, runId: match[1]! };
  }
  if (kind === "redo") {
    const match = /^\s*(\S+)\s+(\S+)(?:\s+([\s\S]*\S))?\s*$/.exec(rawInput);
    if (match === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "Usage: /stock-redo <runId> <taskId> [reason]",
      );
    return {
      kind,
      runId: match[1]!,
      taskId: match[2]!,
      reason: match[3]?.trim() ?? null,
    };
  }
  const match = /^\s*(\S+)\s+([\s\S]*\S)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      `Usage: /stock-${kind} <runId> <JSON>`,
    );
  const runId = match[1]!;
  const value = json(match[2]!);
  if (kind === "recover")
    return {
      kind,
      runId,
      attempts: attempts(value),
    };
  return {
    kind,
    runId,
    input: resumeInput(value),
  };
}
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
