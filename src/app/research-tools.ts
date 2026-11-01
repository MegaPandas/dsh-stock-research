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
    execute: async (value, exec) => actions.review(reviewRequest(value), exec),
  });
}

export function createResearchTools(
  ctx: Context,
  actions: Pick<ResearchActions, "start" | "control">,
): ToolDefinition[] {
  const start = applicationTool(ctx, {
    name: "stock_start_research",
    description:
      "Start requested quick/deep single-stock research: collect fixed data and return runId, tasks and acceptance requirements for the primary agent to execute. date defaults to today in the security's market. Reuse requestId for retries; use a new ID for a new request.",
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
    execute: (value, exec) => actions.start(startRequest(value), exec),
  });
  const definitions = {
    resume: [
      "stock_resume_research",
      "Resume research, revise pending tasks and return the plan. Use [] for unchanged input.resolvedReasonIds and input.instructions.",
    ],
    cancel: [
      "stock_cancel_research",
      "Cancel the selected research and stop its executions, retaining submitted content.",
    ],
    recover: [
      "stock_recover_research",
      "Record interrupted attempts after the user explicitly confirms their executions are lost. Does not start execution.",
    ],
    replay: [
      "stock_replay_research",
      "Create a derived run from the selected research's fixed inputs and return its plan for the primary agent to execute.",
    ],
  } as const;
  return [
    start,
    ...(["resume", "cancel", "recover", "replay"] as const).map((kind) => {
      const [name, description] = definitions[kind];
      return applicationTool(ctx, {
        name,
        description,
        parameters: runControlParameters[kind],
        output: resultOutput(opaqueObjectSchema),
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
            : result.context;
        },
      });
    }),
  ];
}
