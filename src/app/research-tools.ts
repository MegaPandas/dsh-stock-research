import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { researchTool } from "../host/tool-protocol/errors.js";
import {
  artifactRef,
  artifactRefSchema,
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";
import type {
  ResearchActions,
  StartResearchRequest,
  ReviewResearchRequest,
} from "./research-actions.js";
import { securityFor, scopeAtDate } from "./research-scope.js";
import { parseRunControl, runControlParameters } from "./run-command-input.js";
import { runStatus } from "./run-view.js";
import { runApplicationTool } from "./settings.js";

export function applicationTool(
  ctx: Context,
  definition: ToolDefinition,
): ToolDefinition {
  return researchTool({
    ...definition,
    execute: (value, exec) =>
      runApplicationTool(ctx, definition.name, value, exec, () =>
        definition.execute(value, exec),
      ),
  });
}

function startRequest(value: unknown): StartResearchRequest {
  const item = object(value, ["security", "date", "mode", "requestId"]);
  const security = securityFor(text(item.security, "security"));
  const now = new Date();
  const date =
    item.date === undefined
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: security.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now)
      : text(item.date, "date");
  if (item.mode !== "quick" && item.mode !== "deep")
    throw new ResearchError("INVALID_INPUT", "mode must be quick or deep.");
  return {
    scope: scopeAtDate(security, date, now),
    mode: item.mode,
    requestId: text(item.requestId, "requestId"),
  };
}

function reviewRequest(value: unknown): ReviewResearchRequest {
  const item = object(value, [
    "runId",
    "stageId",
    "verdict",
    "feedback",
    "refs",
    "requestId",
  ]);
  const runId = text(item.runId, "runId");
  if (item.verdict !== "accepted" && item.verdict !== "rejected")
    throw new ResearchError(
      "INVALID_INPUT",
      "verdict must be accepted or rejected.",
    );
  if (!Array.isArray(item.refs))
    throw new ResearchError("INVALID_INPUT", "refs requires an array.");
  return {
    runId,
    stageId: text(item.stageId, "stageId"),
    verdict: item.verdict,
    feedback: text(item.feedback, "feedback"),
    refs: item.refs.map(artifactRef),
    requestId: text(item.requestId, "requestId"),
  };
}

export function createResearchReviewTool(
  ctx: Context,
  actions: Pick<ResearchActions, "review">,
): ToolDefinition {
  return applicationTool(ctx, {
    name: "stock_review_stage",
    description:
      "Submit stage acceptance and feedback. refs must cover all current stage artifact versions. After accepted, advance downstream; after rejected, revise artifacts and review again.",
    parameters: objectSchema({
      runId: stringSchema,
      stageId: stringSchema,
      verdict: { type: "string", enum: ["accepted", "rejected"] },
      feedback: stringSchema,
      refs: { type: "array", items: artifactRefSchema },
      requestId: stringSchema,
    }),
    output: resultOutput(opaqueObjectSchema),
    isConcurrencySafe: () => true,
    execute: async (value, exec) => actions.review(reviewRequest(value), exec),
  });
}

export function createResearchTools(
  ctx: Context,
  actions: Pick<ResearchActions, "start" | "control" | "observe" | "cancel">,
): ToolDefinition[] {
  const start = applicationTool(ctx, {
    name: "stock_start_research",
    description:
      "Start quick/deep research in the background and immediately return jobId. Use stock_read_research for its runId and progress, or stock_cancel_research to stop it during collection or execution. Ready tasks run automatically; stage review remains the primary agent's decision. Date defaults to today in the security's market. Reuse requestId for retries.",
    parameters: objectSchema(
      {
        security: stringSchema,
        date: stringSchema,
        mode: { type: "string", enum: ["quick", "deep"] },
        requestId: stringSchema,
      },
      ["security", "mode", "requestId"],
    ),
    output: resultOutput(opaqueObjectSchema),
    isConcurrencySafe: () => true,
    execute: async (value, exec) => actions.start(startRequest(value), exec),
  });
  const definitions = {
    resume: [
      "stock_resume_research",
      "Resume background scheduling with saved inputs and revised pending-task instructions. Return a background handle and current context. Use [] for unchanged input.resolvedReasonIds and input.instructions.",
    ],
    recover: [
      "stock_recover_research",
      "Record interrupted attempts after the user explicitly confirms their executions are lost. Does not start execution.",
    ],
    replay: [
      "stock_replay_research",
      "Create a derived run from fixed inputs and start background scheduling. Return its handle and context; no new collection is performed.",
    ],
  } as const;
  return [
    start,
    applicationTool(ctx, {
      name: "stock_read_research",
      description:
        "Read a background research handle owned by this chat. Returns native Job lifecycle and, after collection, the canonical runId and view.",
      parameters: objectSchema({ jobId: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      isConcurrencySafe: () => true,
      execute: async (value, exec) => {
        const item = object(value, ["jobId"]);
        return actions.observe(text(item.jobId, "jobId"), exec);
      },
    }),
    applicationTool(ctx, {
      name: "stock_cancel_research",
      description:
        "Stop the entire research associated with an owned jobId, including collection before runId exists. Publish cancellation first and wait for execution release; submitted artifacts remain saved.",
      parameters: objectSchema({
        jobId: stringSchema,
        requestId: stringSchema,
      }),
      output: resultOutput(opaqueObjectSchema),
      isConcurrencySafe: () => true,
      execute: async (value, exec) => {
        const item = object(value, ["jobId", "requestId"]);
        return actions.cancel(
          text(item.jobId, "jobId"),
          exec,
          text(item.requestId, "requestId"),
        );
      },
    }),
    ...(["resume", "recover", "replay"] as const).map((kind) => {
      const [name, description] = definitions[kind];
      return applicationTool(ctx, {
        name,
        description,
        parameters: runControlParameters[kind],
        output: resultOutput(opaqueObjectSchema),
        isConcurrencySafe: () => true,
        execute: async (value, exec) => {
          const { command, requestId } = parseRunControl(kind, value);
          if (exec.agent === undefined)
            throw new ResearchError(
              "ACCESS_DENIED",
              "A host Agent is required.",
            );
          const result = await actions.control(command, exec, requestId);
          return result.kind === "status"
            ? { kind: "success", text: runStatus(result.view) }
            : { ...result.context, ...result.handle };
        },
      });
    }),
  ];
}

export function createResearchTaskTools(
  ctx: Context,
  actions: Pick<ResearchActions, "redoTask" | "revise" | "cancelTask">,
): ToolDefinition[] {
  const fields = {
    runId: stringSchema,
    taskId: stringSchema,
    requestId: stringSchema,
  };
  return [
    applicationTool(ctx, {
      name: "stock_redo_task",
      description:
        "Invalidate an owned task and its dependent branch, preserve history, and restart eligible tasks automatically. Optional instruction replaces the target's objective in the same transaction, before any new claim. reason records why it is redone. A cancelled branch requires explicit redo.",
      parameters: objectSchema(
        { ...fields, reason: stringSchema, instruction: stringSchema },
        Object.keys(fields),
      ),
      output: resultOutput(opaqueObjectSchema),
      isConcurrencySafe: () => true,
      execute: async (value, exec) => {
        const item = object(value, [
          ...Object.keys(fields),
          "reason",
          "instruction",
        ]);
        const result = await actions.redoTask(
          {
            runId: text(item.runId, "runId"),
            taskId: text(item.taskId, "taskId"),
            requestId: text(item.requestId, "requestId"),
            reason:
              item.reason === undefined ? null : text(item.reason, "reason"),
            instruction:
              item.instruction === undefined
                ? null
                : text(item.instruction, "instruction"),
          },
          exec,
        );
        return result;
      },
    }),
    applicationTool(ctx, {
      name: "stock_followup_task",
      description:
        "Start a background revision in the original successful child session, retaining its draft. Return jobId immediately. Explain the issue and acceptance criteria in message. resumeSearch=true explicitly resumes paused search while retaining usage and per-search approval beyond budget.",
      parameters: objectSchema(
        { ...fields, message: stringSchema, resumeSearch: { type: "boolean" } },
        [...Object.keys(fields), "message"],
      ),
      output: resultOutput(opaqueObjectSchema),
      isConcurrencySafe: () => true,
      execute: async (value, exec) => {
        const item = object(value, [
          ...Object.keys(fields),
          "message",
          "resumeSearch",
        ]);
        if (
          item.resumeSearch !== undefined &&
          typeof item.resumeSearch !== "boolean"
        )
          throw new ResearchError(
            "INVALID_INPUT",
            "resumeSearch must be boolean.",
          );
        return actions.revise(
          {
            runId: text(item.runId, "runId"),
            taskId: text(item.taskId, "taskId"),
            requestId: text(item.requestId, "requestId"),
            message: text(item.message, "message"),
            resumeSearch: item.resumeSearch === true,
          },
          exec,
        );
      },
    }),
    applicationTool(ctx, {
      name: "stock_cancel_task",
      description:
        "Cancel one task and its declared or disclosed dependent branch, retaining independent work. expectedAttempt is the exact current attempt from run view; use 0 for an unclaimed task. Publish cancellation first, then wait for owned execution release.",
      parameters: objectSchema({
        ...fields,
        expectedAttempt: { type: "integer", minimum: 0 },
        reason: stringSchema,
      }),
      output: resultOutput(opaqueObjectSchema),
      isConcurrencySafe: () => true,
      execute: (value, exec) => {
        const item = object(value, [
          ...Object.keys(fields),
          "expectedAttempt",
          "reason",
        ]);
        if (
          !Number.isSafeInteger(item.expectedAttempt) ||
          (item.expectedAttempt as number) < 0
        )
          throw new ResearchError(
            "INVALID_INPUT",
            "expectedAttempt must be a non-negative safe integer.",
          );
        return actions.cancelTask(
          {
            runId: text(item.runId, "runId"),
            taskId: text(item.taskId, "taskId"),
            requestId: text(item.requestId, "requestId"),
            expectedAttempt: item.expectedAttempt as number,
            reason: text(item.reason, "reason"),
          },
          exec,
        );
      },
    }),
  ];
}
