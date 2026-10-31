import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "../host/runtime.js";
import { SubmittedAgents } from "../host/submitted-agents.js";
import type { ModelConfig } from "../contracts/settings.js";
import { runApplicationCommand } from "./settings.js";
import { parseAskInput } from "./ask-input.js";
import { ASK_PROMPT } from "./ask-prompt.js";
import { ModelConfigSchema, resolveModelOptions } from "./model-config.js";
import { prepareAskRequest } from "./ask-request.js";

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
    return this.executions
      .run(invocation.signal, async (signal) => {
        const input = parseAskInput(invocation.rawInput, new Date());
        const model = resolveModelOptions(
          invocation.agent,
          this.model ?? this.ctx.get("stockResearchSettings")?.model,
        );
        const runtime = this.ctx.stockResearch;
        const prepared = await prepareAskRequest(
          {
            collection: runtime.collection,
            recallTool: () => runtime.createRecallTool(),
          },
          input,
          signal,
        );
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
          binding: { kind: "ask", scope: prepared.scope },
          tools: prepared.tools,
          message: createUserMessage({
            content: prepared.input,
            source: { kind: "user" },
          }),
          result: prepared.result,
        };
      })
      .then((text): CommandResult => ({ kind: "success", text }));
  }

  close(): Promise<void> {
    return this.executions.close();
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
