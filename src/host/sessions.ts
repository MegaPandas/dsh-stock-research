import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { SessionBindings, type ResearchBinding } from "./bindings.js";
import { setupResearchTools } from "./agent-execution.js";

interface SessionPolicy {
  release: () => void;
  active: boolean;
}

/** The host owns Agent handles; this boundary owns their research capabilities. */
export class ResearchSessions {
  readonly dispose: () => Promise<void>;
  readonly #policies = new WeakMap<Agent, SessionPolicy>();
  readonly #active = new Set<SessionPolicy>();
  readonly #reserved = new Map<SessionId, AgentSetup>();
  #closed = false;

  constructor(
    private readonly ctx: Context,
    private readonly bindings: SessionBindings,
  ) {
    const unregisterGuard = ctx.tools.guard((exec) => {
      const agent = exec.agent;
      if (agent === undefined) return;
      const policy = this.#policies.get(agent);
      if (policy === undefined) return;
      if (this.#closed || !policy.active || ctx.agents.get(agent.id) !== agent)
        return "The research Agent is no longer active.";
    });
    const unlisten = ctx.on("agent/created", async ({ agent }) => {
      const setup = this.#reserved.get(agent.id);
      if (setup !== undefined) {
        this.#requireOpen();
        this.#reserved.delete(agent.id);
        const prepared = await setup(agent.ctx, agent);
        prepared?.commit();
      }
      return undefined;
    });
    const close = () => this.close();
    this.dispose = ctx.effect(function* () {
      yield unregisterGuard;
      yield unlisten;
      yield close;
    });
  }

  /** SDK spawn owns setup; its awaited created event still precedes first input. */
  reserve(childId: SessionId, setup: AgentSetup): () => void {
    this.#requireOpen();
    if (
      this.#reserved.has(childId) ||
      this.ctx.agents.get(childId) !== undefined
    )
      throw new ResearchError(
        "ACCESS_DENIED",
        "The research child identity is already in use.",
      );
    this.#reserved.set(childId, setup);
    return () => {
      if (this.#reserved.get(childId) === setup) this.#reserved.delete(childId);
    };
  }

  /** Compose in the SDK's unpublished setup transaction, before any input runs. */
  setup(
    binding: ResearchBinding,
    tools: readonly ToolDefinition[],
  ): AgentSetup {
    const captured = structuredClone(binding);
    const definitions = [...tools];
    return (agentCtx, agent) => {
      this.#requireOpen();
      const verifyTools = setupResearchTools(agentCtx, agent, definitions);

      const policy: SessionPolicy = {
        release: this.bindings.bind(agent, captured),
        active: true,
      };
      this.#policies.set(agent, policy);
      this.#active.add(policy);
      agentCtx.effect(() => () => this.#release(policy));

      return {
        commit: () => {
          this.#requireOpen();
          verifyTools();
        },
      };
    };
  }

  /** Revoke access; scoped restrictions stay installed until the host drains it. */
  close(): void {
    this.#closed = true;
    for (const policy of this.#active) this.#release(policy);
  }

  #release(policy: SessionPolicy): void {
    policy.active = false;
    policy.release();
    this.#active.delete(policy);
  }

  #requireOpen(): void {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Research sessions are closed.");
  }
}
