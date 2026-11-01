import type {
  ResearchControl,
  ResearchControlKind,
} from "./research-actions.js";
import { ResearchError } from "../contracts/errors.js";
import type { AttemptTarget, ResumeRunInput } from "../contracts/runs.js";
import {
  object,
  objectSchema,
  positive,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";

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
export type ResearchToolControlKind = Exclude<
  ResearchControlKind,
  "status" | "redo" | "cancel"
>;
const controlFields = { runId: stringSchema, requestId: stringSchema };
export const runControlParameters = {
  resume: objectSchema({ ...controlFields, input: resumeInputSchema }),
  recover: objectSchema({ ...controlFields, attempts: attemptsSchema }),
  replay: objectSchema(controlFields),
} satisfies Record<ResearchToolControlKind, JsonSchemaNode>;

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
  kind: ResearchToolControlKind,
  value: unknown,
): {
  command: ResearchControl;
  requestId: string;
} {
  const actionFields =
    kind === "resume" ? ["input"] : kind === "recover" ? ["attempts"] : [];
  const item = object(value, ["runId", "requestId", ...actionFields]);
  const runId = text(item.runId, "runId");
  const requestId = text(item.requestId, "requestId");
  let command: ResearchControl;
  switch (kind) {
    case "resume":
      command = { kind, runId, input: resumeInput(item.input) };
      break;
    case "recover":
      command = { kind, runId, attempts: attempts(item.attempts) };
      break;
    case "replay":
      command = { kind, runId };
      break;
  }
  return { command, requestId };
}
export function parseRunCommand(
  kind: ResearchControlKind,
  rawInput: string,
): ResearchControl {
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
      instruction: null,
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
