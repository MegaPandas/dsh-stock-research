import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { runApplicationCommand } from "./settings.js";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "../host/runtime.js";
import {
  SubmittedAgents,
  type SubmittedAgentRequest,
} from "../host/submitted-agents.js";
import { agentInput, createSubmission } from "../host/agent-execution.js";
import { renderAgentReport } from "../report/agent-report.js";
import { parseAskInput, type AskInput } from "./ask-input.js";
import { ASK_PROMPT } from "./ask-prompt.js";
import { ModelConfigSchema, resolveModelOptions } from "./model-config.js";
import type { ModelConfig } from "../contracts/settings.js";
import { researchCutoff } from "./ask-input.js";
import { collectionReadTools } from "./collection-tools.js";
import { collectionDirectory } from "./collection-input.js";
import { requireCollectionData } from "./collection-snapshot.js";

export type AskConfig = ModelConfig;
export const Config = ModelConfigSchema.required(false);

class AskApplication {
  private readonly executions: SubmittedAgents;
  constructor(
    private readonly ctx: Context,
    private readonly model: AskConfig | undefined,
  ) {
    this.executions = new SubmittedAgents(
      (...args) => ctx.stockResearch.createAgent(...args),
      "ask",
    );
  }

  run(invocation: CommandInvocation): Promise<CommandResult> {
    return this.executions.run(invocation.signal, (signal) => {
      const input = parseAskInput(invocation.rawInput, new Date());
      const model = resolveModelOptions(
        invocation.agent,
        this.model ?? this.ctx.get("stockResearchSettings")?.model,
      );
      return this.#answer(input, model, signal);
    });
  }

  close(): Promise<void> {
    return this.executions.close();
  }

  async #answer(
    input: AskInput,
    model: AgentOptions,
    signal: AbortSignal,
  ): Promise<SubmittedAgentRequest<CommandResult>> {
    signal.throwIfAborted();
    const runtime = this.ctx.stockResearch;
    const collection = await runtime.collection.collect(input.scope, signal);
    requireCollectionData(collection);
    input = {
      ...input,
      scope: {
        ...input.scope,
        cutoff: researchCutoff(input.scope, new Date()),
      },
    };
    runtime.collection.finalizeScope(collection, input.scope);
    const tools = [runtime.createRecallTool()];
    const submission = createSubmission("ask", (report) =>
      renderAgentReport("ask", report).trimEnd(),
    );
    tools.push(...collectionReadTools(collection.packets), submission.tool);
    return {
      options: {
        sessionId: SessionId(randomUUID()),
        agentOptions: model,
        setup: (agentCtx) => {
          agentCtx.systemPrompt.section({
            name: "stock:ask",
            order: 0,
            text: ASK_PROMPT,
            interpolate: false,
            complete: true,
          });
        },
      },
      binding: { kind: "ask", scope: input.scope },
      tools,
      message: createUserMessage({
        content: agentInput({
          scope: input.scope,
          task: { role: "ask", objective: input.question },
          context: {
            dataCatalog: collectionDirectory(collection.packets),
            collectionFailures: collection.failures,
          },
        }),
        source: { kind: "user" },
      }),
      result: () => ({ kind: "success", text: submission.result() }),
    };
  }
}

export const name = "stock-ask";
export const inject = ["stockResearch", "commands", "systemPrompt"];
export function apply(ctx: Context, config?: AskConfig): void {
  const app = new AskApplication(ctx, structuredClone(config));
  ctx.effect(function* () {
    yield () => app.close();
    yield ctx.commands.register({
      name: "stock-ask",
      description: "按指定股票和研究日期作只读问答。",
      input: {
        hint: "标的 YYYY-MM-DD 问题；标的如SZ.002594、NASDAQ:NVDA或NYSE:IBM",
      },
      handler: (invocation) =>
        runApplicationCommand(ctx, "stock-ask", invocation, () =>
          app.run(invocation),
        ),
    });
  });
}
