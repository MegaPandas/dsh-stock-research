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
    description: "run_view中已解决的blockReasons.id；没有待解除原因时传[]。",
  },
  instructions: {
    type: "array",
    items: objectSchema({ taskId: stringSchema, instruction: stringSchema }),
    description:
      "待执行任务的新说明；没有修订时传[]。仅更新pending或failed任务。",
  },
});
const attemptsSchema = {
  type: "array",
  items: objectSchema({ taskId: stringSchema, attempt: { type: "integer" } }),
} as const;
export const runControlParameters: JsonSchemaNode & Record<string, unknown> = {
  oneOf: [
    objectSchema({
      action: { type: "string", const: "resume" },
      runId: stringSchema,
      requestId: stringSchema,
      input: resumeInputSchema,
    }),
    objectSchema(
      {
        action: { type: "string", const: "redo" },
        runId: stringSchema,
        requestId: stringSchema,
        taskId: stringSchema,
        reason: stringSchema,
      },
      ["action", "runId", "requestId", "taskId"],
    ),
    objectSchema({
      action: { type: "string", const: "recover" },
      runId: stringSchema,
      requestId: stringSchema,
      attempts: attemptsSchema,
    }),
    objectSchema({
      action: { type: "string", enum: ["cancel", "replay"] },
      runId: stringSchema,
      requestId: stringSchema,
    }),
  ],
};

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

export function parseRunControl(value: unknown): {
  command: RunCommand;
  requestId: string;
} {
  const action = (value as { action?: unknown } | null)?.action;
  const actionFields =
    action === "resume"
      ? ["input"]
      : action === "redo"
        ? ["taskId", "reason"]
        : action === "recover"
          ? ["attempts"]
          : [];
  const item = object(value, ["action", "runId", "requestId", ...actionFields]);
  const kind = text(item.action, "action");
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
    case "redo":
      command = {
        kind,
        runId,
        taskId: text(item.taskId, "taskId"),
        reason: item.reason === undefined ? null : text(item.reason, "reason"),
      };
      break;
    case "cancel":
    case "replay":
      command = { kind, runId };
      break;
    default:
      throw new ResearchError(
        "INVALID_INPUT",
        "Unknown research control action.",
      );
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
