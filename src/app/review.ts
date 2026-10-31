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
import type {} from "../host/runtime.js";
import {
  SubmittedAgents,
  type SubmittedAgentRequest,
} from "../host/submitted-agents.js";
import { agentInput, createSubmission } from "../host/agent-execution.js";
import { ArtifactInputs } from "../services/artifact-inputs.js";
import { ModelConfigSchema, resolveModelOptions } from "./model-config.js";
import type { ModelConfig } from "../contracts/settings.js";
import { parseReviewInput, type ReviewInput } from "./review-input.js";
import { REVIEW_PROMPT } from "./review-prompt.js";
import { createReportReader } from "./report-reader.js";
import { ReviewSession } from "./review-session.js";
import { createReviewTools } from "./review-tools.js";

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
    return this.executions.run(invocation.signal, (signal) => {
      const input = parseReviewInput(
        invocation.rawInput,
        new Date(),
        this.ctx.stockResearch.runs,
      );
      const model = resolveModelOptions(
        invocation.agent,
        this.model ?? this.ctx.get("stockResearchSettings")?.model,
      );
      return this.#review(input, model, signal);
    });
  }

  close(): Promise<void> {
    return this.executions.close();
  }

  async #review(
    input: ReviewInput,
    model: AgentOptions,
    signal: AbortSignal,
  ): Promise<SubmittedAgentRequest<CommandResult>> {
    const runtime = this.ctx.stockResearch;
    const sessionId = SessionId(randomUUID());
    const policy = runtime.policy;
    const inputs = new ArtifactInputs(runtime.runs);
    const currentReports = runtime.runs
      .view({ runId: input.runId })
      .tasks.flatMap(({ outputRefs }) => outputRefs)
      .map((ref) => inputs.artifact(ref));
    const reports = inputs.closure(currentReports.map(({ ref }) => ref));
    const reader = createReportReader(reports, []);
    const selectedDecision =
      currentReports.find(({ content }) => content.kind === "decision") ??
      currentReports.find(({ content }) => content.kind === "decision_draft");
    let referencePrice: { value: number; unit: string } | null = null;
    if (
      selectedDecision?.content.kind === "decision" ||
      selectedDecision?.content.kind === "decision_draft"
    ) {
      const { basePrice } = selectedDecision.content.payload;
      if (basePrice !== null) {
        const local =
          selectedDecision.content.kind === "decision"
            ? selectedDecision.content.payload.draftRef
            : selectedDecision.ref;
        const { claim } = inputs.number(basePrice, local);
        referencePrice = { value: claim.value, unit: claim.unit };
      }
    }
    const session = new ReviewSession(
      input,
      currentReports
        .filter(
          ({ content }) =>
            content.kind === "decision" || content.kind === "report",
        )
        .map(({ ref }) => ref),
      {
        memory: runtime.memory,
        queryReturns: (scope, request, signal) =>
          runtime.queries.query(scope, request, signal),
      },
    );
    signal.throwIfAborted();
    const tools = [
      runtime.createDataHealthTool(),
      runtime.createRecallTool(),
      ...createReviewTools(session, input.scope, policy),
      reader.tool,
    ];
    const submission = createSubmission("review", (report, exec) => {
      signal.throwIfAborted();
      return session.submit(report, exec.agent!.id, exec.callId, exec.signal);
    });
    tools.push(submission.tool);
    return {
      options: {
        sessionId,
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
      binding: { kind: "review", runId: input.runId, scope: input.scope },
      tools,
      message: createUserMessage({
        content: agentInput({
          scope: input.scope,
          task: { role: "review", objective: input.question },
          context: {
            runId: input.runId,
            originalScope: input.originalScope,
            referencePrice,
            reportCatalog: reader.catalog,
            availableSources: runtime.queries
              .health(input.scope)
              .sources.filter((source) => source.capability !== null),
          },
        }),
        source: { kind: "user" },
      }),
      result: () => {
        const saved = submission.result();
        const entry = runtime.memory.read(saved);
        return {
          kind: "success",
          text: `复盘已保存：${saved.entryId}@${saved.revision}\n\n${entry.outcome}${entry.note === entry.outcome ? "" : `\n\n${entry.note}`}`,
        };
      },
    };
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
