import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "../host/runtime.js";
import { SubmittedAgents } from "../host/submitted-agents.js";
import type { ModelConfig } from "../contracts/settings.js";
import { runApplicationCommand } from "./settings.js";
import { ModelConfigSchema, resolveModelOptions } from "./model-config.js";
import { parseReviewInput } from "./review-input.js";
import { REVIEW_PROMPT } from "./review-prompt.js";
import { prepareReviewRequest } from "./review-request.js";

class ReviewApplication {
  private readonly executions: SubmittedAgents;
  constructor(
    private readonly ctx: Context,
    private readonly model: ModelConfig | undefined,
  ) {
    this.executions = new SubmittedAgents(
      (...args) => ctx.stockResearch.createAgent(...args),
      "review",
    );
  }

  run(invocation: CommandInvocation): Promise<CommandResult> {
    return this.executions
      .run(invocation.signal, async (signal) => {
        const input = parseReviewInput(
          invocation.rawInput,
          new Date(),
          this.ctx.stockResearch.runs,
        );
        const model = resolveModelOptions(
          invocation.agent,
          this.model ?? this.ctx.get("stockResearchSettings")?.model,
        );
        const runtime = this.ctx.stockResearch;
        const prepared = prepareReviewRequest(
          {
            runs: runtime.runs,
            memory: runtime.memory,
            queryReturns: (scope, request, signal) =>
              runtime.queries.query(scope, request, signal),
            sourceHealth: (scope) => runtime.queries.health(scope).sources,
            policy: runtime.policy,
            recallTool: () => runtime.createRecallTool(),
            healthTool: () => runtime.createDataHealthTool(),
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
                name: "stock:review",
                order: 0,
                text: REVIEW_PROMPT,
                complete: true,
                interpolate: false,
              });
            },
          },
          binding: {
            kind: "review",
            runId: input.runId,
            scope: prepared.scope,
          },
          tools: prepared.tools,
          message: createUserMessage({
            content: prepared.input,
            source: { kind: "user" },
          }),
          result: prepared.result,
        };
      })
      .then(({ ref, outcome, note }): CommandResult => ({
        kind: "success",
        text: `复盘已保存：${ref.entryId}@${ref.revision}\n\n${outcome}${note === outcome ? "" : `\n\n${note}`}`,
      }));
  }

  close(): Promise<void> {
    return this.executions.close();
  }
}

export const Config = ModelConfigSchema.required(false);
export const name = "stock-review";
export const inject = ["stockResearch", "commands", "systemPrompt"];
export function apply(ctx: Context, config?: ModelConfig): void {
  const app = new ReviewApplication(ctx, structuredClone(config));
  ctx.effect(function* () {
    yield () => app.close();
    yield ctx.commands.register({
      name: "stock-review",
      description: "按选定历史运行与复盘日期分析结果并保存独立记忆。",
      input: { hint: "runId YYYY-MM-DD 复盘问题" },
      handler: (invocation) =>
        runApplicationCommand(ctx, "stock-review", invocation, () =>
          app.run(invocation),
        ),
    });
  });
}
