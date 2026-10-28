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
import type {} from "@deepseek-ai/dsh-system-prompt";
import { ResearchError } from "../contracts/errors.js";
import type {} from "../host/runtime.js";
import { agentInput, createSubmission } from "../host/agent-execution.js";
import { renderAgentReport } from "../report/agent-report.js";
import { parseAskInput, type AskInput } from "./ask-input.js";
import { ASK_PROMPT, ASK_TOOL_NAMES } from "./ask-prompt.js";
import { scopedQueryParameters } from "./query-scope.js";
import { ModelConfig, resolveModelOptions } from "./model-config.js";
import { researchCutoff } from "./ask-input.js";
import { collectionReadTool } from "./collection-tools.js";
import {
  collectionDirectory,
  requireCollectionData,
} from "./collection-input.js";

export type AskConfig = ModelConfig;
export const Config = ModelConfig.required(false);

interface ActiveAsk {
  controller: AbortController;
  drained: Promise<unknown[]>;
}

class AskApplication {
  readonly #active = new Set<ActiveAsk>();
  #closed = false;

  constructor(
    private readonly ctx: Context,
    private readonly model: AskConfig | undefined,
  ) {}

  run(invocation: CommandInvocation): Promise<CommandResult> {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Stock ask is closed.");
    invocation.signal.throwIfAborted();
    const input = parseAskInput(invocation.rawInput, new Date());
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, invocation.signal]);
    const failures: unknown[] = [];
    const model = resolveModelOptions(
      invocation.agent,
      this.model ?? this.ctx.get("stockResearchSettings")?.model,
    );
    // Publish ownership before the asynchronous Agent creation can start.
    const work = Promise.resolve()
      .then(() => this.#answer(input, model, signal, failures))
      .finally(() => this.#active.delete(active));
    const active: ActiveAsk = {
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
    for (const request of active) request.controller.abort();
    const failures = (
      await Promise.all(active.map((request) => request.drained))
    ).flat();
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not release ask Agents.", {
        cause: failures[0],
      });
  }

  async #answer(
    input: AskInput,
    model: AgentOptions,
    signal: AbortSignal,
    failures: unknown[],
  ): Promise<CommandResult> {
    let handle: AgentHandle | undefined;
    let modelFailure: { cause: unknown } | undefined;
    const cancel = () =>
      handle?.agent.cancel({ kind: this.#closed ? "disposed" : "user" });
    const outcome = await Promise.resolve()
      .then(async (): Promise<CommandResult> => {
        signal.throwIfAborted();
        const runtime = this.ctx.stockResearch;
        const collection = await runtime.collection.collect(
          input.scope,
          signal,
        );
        requireCollectionData(collection);
        input = {
          ...input,
          scope: {
            ...input.scope,
            cutoff: researchCutoff(input.scope, new Date()),
          },
        };
        runtime.collection.finalizeScope(collection, input.scope);
        const tools = runtime.tools
          .filter((tool) => ASK_TOOL_NAMES.has(tool.name))
          .map((tool) => ({
            ...tool,
            parameters: scopedQueryParameters(tool.parameters, false),
          }));
        const submission = createSubmission("ask", (report) =>
          renderAgentReport("ask", report).trimEnd(),
        );
        tools.push(collectionReadTool(collection.packets), submission.tool);
        handle = await runtime.createAgent(
          {
            sessionId: SessionId(randomUUID()),
            agentOptions: model,
            signal,
            setup: (agentCtx) => {
              agentCtx.systemPrompt.section({
                name: "stock:ask",
                order: 0,
                text: ASK_PROMPT,
                interpolate: false,
                complete: true,
              });
              agentCtx.on("agent/error", ({ error }) => {
                modelFailure = { cause: error };
              });
            },
          },
          { kind: "ask", scope: input.scope },
          tools,
        );
        signal.addEventListener("abort", cancel, { once: true });
        signal.throwIfAborted();
        handle.agent.followup(
          createUserMessage({
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
        );
        await handle.agent.whenIdle();
        signal.throwIfAborted();
        if (modelFailure !== undefined) throw modelFailure.cause;
        return { kind: "success", text: submission.result() };
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
      throw new AggregateError(causes, "Ask execution cleanup failed.", {
        cause: causes[0],
      });
    }
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
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
