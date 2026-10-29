import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { TaskOperation } from "../contracts/runs.js";

export interface ResearchCaller {
  agent?: Agent | undefined;
  signal: AbortSignal;
}

export type ResearchBinding =
  | { kind: "coordinator"; runIds: readonly string[] }
  | { kind: "task"; runId: string; taskId: string; attempt: number }
  | { kind: "ask"; scope: ResearchScope }
  | { kind: "review"; runId: string; scope: ResearchScope };
export interface BoundCaller {
  agent: Agent;
  binding: ResearchBinding;
}

/** Bindings are installed by trusted host code, never from model arguments. */
export class SessionBindings {
  readonly #bindings = new WeakMap<Agent, ResearchBinding>();

  bind(agent: Agent, binding: ResearchBinding): () => void {
    if (this.#bindings.has(agent))
      throw new ResearchError(
        "ACCESS_DENIED",
        "This Agent already has a research binding.",
      );
    const captured = structuredClone(binding);
    this.#bindings.set(agent, captured);
    return () => {
      if (this.#bindings.get(agent) === captured) this.#bindings.delete(agent);
    };
  }
  require(agent: Agent | undefined): BoundCaller {
    const binding = agent === undefined ? undefined : this.#bindings.get(agent);
    if (agent === undefined || binding === undefined)
      throw new ResearchError(
        "ACCESS_DENIED",
        "A trusted research Agent binding is required.",
      );
    return { agent, binding };
  }
}
export function authorizeRun(binding: ResearchBinding, runId: string): void {
  const allowed =
    binding.kind === "coordinator"
      ? binding.runIds.includes(runId)
      : binding.kind !== "ask" && binding.runId === runId;
  if (!allowed)
    throw new ResearchError(
      "ACCESS_DENIED",
      "The run is outside the caller's research binding.",
    );
}
export function taskOperation(caller: BoundCaller): TaskOperation {
  if (caller.binding.kind !== "task")
    throw new ResearchError(
      "ACCESS_DENIED",
      "This operation requires a bound research task.",
    );
  return {
    runId: caller.binding.runId,
    taskId: caller.binding.taskId,
    attempt: caller.binding.attempt,
    identity: caller.agent.id,
    sessionId: caller.agent.id,
  };
}
