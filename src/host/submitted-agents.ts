import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import type { ResearchBinding } from "./bindings.js";

export type CreateBoundAgent = (
  options: CreateAgentOptions,
  binding: ResearchBinding,
  tools: readonly ToolDefinition[],
) => Promise<AgentHandle>;

export interface SubmittedAgentRequest<Result> {
  options: Omit<CreateAgentOptions, "signal">;
  binding: ResearchBinding;
  tools: readonly ToolDefinition[];
  message: Parameters<Agent["followup"]>[0];
  result(): Result;
}
interface ActiveRequest {
  controller: AbortController;
  drained: Promise<unknown[]>;
}

/** Owns application requests and their single submitted-result Agent. */
export class SubmittedAgents {
  private readonly active = new Set<ActiveRequest>();
  private closed = false;

  constructor(
    private readonly create: CreateBoundAgent,
    private readonly kind: "ask" | "review",
  ) {}

  run<Result>(
    signal: AbortSignal,
    prepare: (signal: AbortSignal) => Promise<SubmittedAgentRequest<Result>>,
  ): Promise<Result> {
    if (this.closed)
      throw new ResearchError("ACCESS_DENIED", `Stock ${this.kind} is closed.`);
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    const failures: unknown[] = [];
    let finish!: (failures: unknown[]) => void;
    const active: ActiveRequest = {
      controller,
      drained: new Promise((resolve) => {
        finish = resolve;
      }),
    };
    this.active.add(active);
    // Preparation starts after ownership is recorded and captures command-time inputs synchronously.
    return this.execute(prepare, combined, failures).finally(() => {
      this.active.delete(active);
      finish(failures);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.active];
    for (const request of active) request.controller.abort();
    const failures = (
      await Promise.all(active.map((request) => request.drained))
    ).flat();
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Could not release ${this.kind} Agents.`,
        { cause: failures[0] },
      );
  }

  private async execute<Result>(
    prepare: (signal: AbortSignal) => Promise<SubmittedAgentRequest<Result>>,
    signal: AbortSignal,
    failures: unknown[],
  ): Promise<Result> {
    let handle: AgentHandle | undefined;
    let failure: { cause: unknown } | undefined;
    const cancel = () =>
      handle?.agent.cancel({ kind: this.closed ? "disposed" : "user" });
    signal.addEventListener("abort", cancel, { once: true });
    const outcome = await (async () => {
      const request = await prepare(signal);
      signal.throwIfAborted();
      handle = await this.create(
        {
          ...request.options,
          signal,
          setup: (ctx, agent) => {
            ctx.on("agent/error", ({ agent: subject, error }) => {
              if (subject === agent) failure ??= { cause: error };
            });
            return request.options.setup?.(ctx, agent);
          },
        },
        request.binding,
        request.tools,
      );
      signal.throwIfAborted();
      handle.agent.followup(request.message);
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      if (failure !== undefined) throw failure.cause;
      return request.result();
    })().then(
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
      const title = this.kind === "ask" ? "Ask" : "Review";
      throw new AggregateError(causes, `${title} execution cleanup failed.`, {
        cause: causes[0],
      });
    }
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }
}
