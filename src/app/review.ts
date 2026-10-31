import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { runApplicationCommand } from "./settings.js";
import type { AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ResearchError } from "../contracts/errors.js";
import type {} from "../host/runtime.js";
import { agentInput, createSubmission } from "../host/agent-execution.js";
import { ArtifactInputs } from "../services/artifact-inputs.js";
import { ModelConfigSchema, resolveModelOptions } from "./model-config.js";
import type { ModelConfig } from "../contracts/settings.js";
import { parseReviewInput, type ReviewInput } from "./review-input.js";
import { REVIEW_PROMPT } from "./review-prompt.js";
import { createReportReader } from "./report-reader.js";
import { ReviewSession } from "./review-session.js";
import { createReviewTools } from "./review-tools.js";

interface ActiveReview {
  controller: AbortController;
  drained: Promise<unknown[]>;
}

class ReviewApplication {
  readonly #active = new Set<ActiveReview>();
  #closed = false;
  constructor(
    private readonly ctx: Context,
    private readonly model: ModelConfig | undefined,
  ) {}

  run(invocation: CommandInvocation): Promise<CommandResult> {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Stock review is closed.");
    invocation.signal.throwIfAborted();
    const input = parseReviewInput(
      invocation.rawInput,
      new Date(),
      this.ctx.stockResearch.runs,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, invocation.signal]);
    const failures: unknown[] = [];
    const model = resolveModelOptions(
      invocation.agent,
      this.model ?? this.ctx.get("stockResearchSettings")?.model,
    );
    const work = Promise.resolve()
      .then(() => this.#review(input, model, signal, failures))
      .finally(() => this.#active.delete(active));
    const active: ActiveReview = {
      controller,
      drained: work.then(
        () => failures,
        () => failures,
      ),
    };
    this.#active.add(active);
    return work;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active];
    for (const entry of active) entry.controller.abort();
    const failures = (
      await Promise.all(active.map((entry) => entry.drained))
    ).flat();
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not release review Agents.", {
        cause: failures[0],
      });
  }

  async #review(
    input: ReviewInput,
    model: AgentOptions,
    signal: AbortSignal,
    failures: unknown[],
  ): Promise<CommandResult> {
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
    let handle: AgentHandle | undefined;
    let failure: { cause: unknown } | undefined;
    const cancel = () =>
      handle?.agent.cancel({ kind: this.#closed ? "disposed" : "user" });
    signal.addEventListener("abort", cancel, { once: true });
    const outcome = await Promise.resolve()
      .then(async (): Promise<CommandResult> => {
        signal.throwIfAborted();
        const tools = [
          runtime.createDataHealthTool(),
          runtime.createRecallTool(),
          ...createReviewTools(session, input.scope, policy),
          reader.tool,
        ];
        const submission = createSubmission("review", (report, exec) => {
          signal.throwIfAborted();
          return session.submit(
            report,
            exec.agent!.id,
            exec.callId,
            exec.signal,
          );
        });
        tools.push(submission.tool);
        handle = await runtime.createAgent(
          {
            sessionId,
            agentOptions: model,
            signal,
            setup: (agentCtx, agent) => {
              agentCtx.systemPrompt.section({
                name: "stock:review",
                order: 0,
                text: REVIEW_PROMPT,
                complete: true,
                interpolate: false,
              });
              agentCtx.on("agent/error", ({ agent: subject, error }) => {
                if (subject === agent) failure ??= { cause: error };
              });
            },
          },
          { kind: "review", runId: input.runId, scope: input.scope },
          tools,
        );
        signal.throwIfAborted();
        handle.agent.followup(
          createUserMessage({
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
        );
        await handle.agent.whenIdle();
        signal.throwIfAborted();
        if (failure !== undefined) throw failure.cause;
        const saved = submission.result();
        const entry = runtime.memory.read(saved);
        return {
          kind: "success",
          text: `复盘已保存：${saved.entryId}@${saved.revision}\n\n${entry.outcome}${entry.note === entry.outcome ? "" : `\n\n${entry.note}`}`,
        };
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    signal.removeEventListener("abort", cancel);
    const cleanup = await Promise.allSettled(
      handle === undefined ? [] : [handle.dispose()],
    );
    failures.push(
      ...cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    );
    if (failures.length > 0) {
      const causes =
        outcome.status === "rejected"
          ? [outcome.reason, ...failures]
          : failures;
      throw new AggregateError(causes, "Review execution cleanup failed.", {
        cause: causes[0],
      });
    }
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
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
