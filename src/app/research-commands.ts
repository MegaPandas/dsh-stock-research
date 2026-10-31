import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CommandDefinition,
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { RunDefinition } from "../contracts/workflow.js";
import type {
  ResearchActions,
  ResearchControlKind,
} from "./research-actions.js";
import { parseResearchInput } from "./ask-input.js";
import { parseRunCommand } from "./run-command-input.js";
import { runStatus } from "./run-view.js";
import { runApplicationCommand } from "./settings.js";

function requestResearch(
  invocation: CommandInvocation,
  mode: RunDefinition["mode"],
): CommandResult {
  invocation.signal.throwIfAborted();
  const selection = parseResearchInput(invocation.rawInput, new Date(), mode);
  invocation.agent.followup(
    createUserMessage({
      content: [
        {
          type: "text",
          text: `Research ${selection.security} as of ${selection.scope.date} using the ${mode} workflow. Dispatch tasks, review stages and deliver the final response in Chinese.\nResearch request: ${JSON.stringify({ kind: "fresh", security: selection.security, date: selection.scope.date, mode })}`,
        },
      ],
      source: { kind: "user" },
    }),
  );
  return { kind: "success", text: "研究请求已交给当前主 Agent。" };
}

async function controlResearch(
  actions: Pick<ResearchActions, "control">,
  invocation: CommandInvocation,
  kind: ResearchControlKind,
): Promise<CommandResult> {
  const operationId = randomUUID();
  const result = await actions.control(
    parseRunCommand(kind, invocation.rawInput),
    invocation,
    operationId,
  );
  if (result.kind === "status")
    return { kind: "success", text: runStatus(result.view) };
  const context = result.context;
  if (context.view.status !== "active")
    return { kind: "error", text: runStatus(context.view) };
  invocation.agent.followup(
    createUserMessage({
      content: [
        {
          type: "text",
          text: `Continue this research, dispatching and reviewing tasks according to its current state.\nResearch request: ${JSON.stringify({ kind, operationId, ...context })}`,
        },
      ],
      source: { kind: "user" },
    }),
  );
  return {
    kind: "success",
    text: `运行 ${context.runId} 已交给当前主 Agent 继续。`,
  };
}

export function createResearchCommands(
  ctx: Context,
  actions: Pick<ResearchActions, "control">,
): CommandDefinition[] {
  return [
    ...(["quick", "deep"] as const).map((mode): CommandDefinition => ({
      name: `stock-${mode}`,
      description: `让当前主Agent按${mode}流程组织个股研究。`,
      input: { hint: "标的 YYYY-MM-DD" },
      handler: (invocation) =>
        runApplicationCommand(ctx, `stock-${mode}`, invocation, async () =>
          requestResearch(invocation, mode),
        ),
    })),
    ...(
      ["status", "resume", "redo", "cancel", "recover", "replay"] as const
    ).map((kind): CommandDefinition => ({
      name: `stock-${kind}`,
      description: `对用户选择的研究运行执行${kind}。`,
      input: {
        hint:
          kind === "resume"
            ? 'runId {"resolvedReasonIds":[],"instructions":[]}'
            : kind === "recover"
              ? 'runId [{"taskId":"...","attempt":1}]'
              : kind === "redo"
                ? "runId taskId [reason]"
                : "runId",
      },
      handler: (invocation) =>
        runApplicationCommand(ctx, `stock-${kind}`, invocation, () =>
          controlResearch(actions, invocation, kind),
        ),
    })),
  ];
}
