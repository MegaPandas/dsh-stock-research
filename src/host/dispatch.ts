import { continueChild } from "./child-continuation.js";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  errorChain,
  HarnessError,
  type ContentBlock,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
  SubagentActivation,
  SubagentResult,
} from "@deepseek-ai/dsh-subagent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  ArtifactCommitResult,
  AttemptTarget,
  CancelRunResult,
  RedoTaskResult,
  RecoverAttemptsResult,
  RoleDispatchContext,
  RunOperation,
  TaskAttempt,
  TaskFailure,
  TaskOperation,
} from "../contracts/runs.js";
import type { RunService } from "../services/runs.js";
import type { DigestService } from "../services/digests.js";
import type { ResearchSessions } from "./sessions.js";
import { observeModelCalls } from "./model-events.js";
import { readResearchModels } from "../app/research-models.js";

export interface RoleProvision {
  followup?(
    next: RoleDispatchContext,
    options: { resumeSearch: boolean },
  ): RoleProvision;
  agentPreset?: string;
  prompt: ContentBlock[];
  tools: readonly ToolDefinition[];
  systemPrompt?: string;
}
export const ROLE_PROMPT_SECTION = "stock:research-role";
export type PrepareRole = (
  context: RoleDispatchContext,
  parent: Agent,
) => RoleProvision;
export interface DispatchResult {
  runId: string;
  taskId: string;
  attempt: number;
  status: TaskAttempt["status"];
  sessionId: string | null;
  refs: ArtifactRef[];
  failure: TaskFailure | null;
}
export interface StageDispatchResult {
  runId: string;
  stageId: string;
  results: DispatchResult[];
}
interface RoleSession {
  parent: Agent;
  childId: SessionId;
  provision: RoleProvision;
  attempt: number;
}
interface FollowupReceipt {
  parent: Agent;
  runId: string;
  requestId: string;
  payload: string;
  result: Promise<DispatchResult>;
}
interface StageReceipt {
  parent: Agent;
  runId: string;
  requestId: string;
  stageId: string;
  result: Promise<StageDispatchResult>;
}
interface OwnedAttempt {
  runId: string;
  taskId: string;
  attempt: number;
  controller: AbortController;
  result: Promise<DispatchResult>;
  drained: Promise<unknown[]>;
}

function attemptKey(runId: string, target: AttemptTarget): string {
  return JSON.stringify([runId, target.taskId, target.attempt]);
}
function executionFailure(cause: unknown, signal: AbortSignal): TaskFailure {
  return {
    code:
      cause instanceof ResearchError
        ? cause.code
        : cause instanceof HarnessError
          ? cause.code
          : signal.aborted
            ? "CANCELLED"
            : "HOST_FAILED",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

type StopBarrier = Promise<PromiseSettledResult<void>>;

async function finishStops(stops: readonly Promise<void>[]): Promise<void> {
  const failures = (await Promise.allSettled(stops)).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Could not stop research executions.", {
      cause: failures[0],
    });
}

/** Own host execution lifetimes; task readiness and invalidation belong to RunService. */
export class DispatchBridge {
  readonly #active = new Map<string, OwnedAttempt>();
  readonly #barriers = new Map<string, Set<StopBarrier>>();
  readonly #roleSessions = new Map<string, RoleSession>();
  readonly #followupReceipts: FollowupReceipt[] = [];
  readonly #stageReceipts: StageReceipt[] = [];
  readonly #unlistenParent: () => void;
  #closed = false;

  constructor(
    private readonly ctx: Context,
    private readonly runs: RunService,
    private readonly sessions: ResearchSessions,
    private readonly prepare: PrepareRole,
    private readonly digests: DigestService,
  ) {
    this.#unlistenParent = ctx.on("agent/disposed", ({ agent }) => {
      for (const [key, session] of this.#roleSessions)
        if (session.parent === agent) this.#roleSessions.delete(key);
      for (let i = this.#followupReceipts.length - 1; i >= 0; i--)
        if (this.#followupReceipts[i]!.parent === agent)
          this.#followupReceipts.splice(i, 1);
      for (let i = this.#stageReceipts.length - 1; i >= 0; i--)
        if (this.#stageReceipts[i]!.parent === agent)
          this.#stageReceipts.splice(i, 1);
    });
  }

  dispatch(
    parent: Agent,
    runId: string,
    taskId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    return this.#afterStops(runId, taskId, signal, () => {
      if (
        this.runs.hasClaimReceipt(
          { runId, identity: parent.id },
          JSON.stringify(["dispatch", requestId]),
        )
      )
        return this.#startRole(parent, runId, taskId, requestId, signal);
      const definition = this.runs.readDefinition(runId);
      const stage = definition.stages?.find((entry) =>
        entry.taskIds.includes(taskId),
      );
      if (stage?.dispatch === "together") {
        const ready = new Set(this.runs.view({ runId }).readyTasks);
        const readyPeers = stage.taskIds.filter((id) => ready.has(id));
        if (readyPeers.length > 1)
          throw new ResearchError(
            "INVALID_INPUT",
            `This stage requires ready roles to start together. Use stock_dispatch_stage with stageId=${stage.id}.`,
          );
      }
      return this.#startRole(parent, runId, taskId, requestId, signal);
    });
  }

  dispatchStage(
    parent: Agent,
    runId: string,
    stageId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<StageDispatchResult> {
    const operation = { runId, identity: parent.id };
    this.runs.hasStageDispatchReceipt(operation, stageId, requestId);
    const receipt = this.#stageReceipts.find(
      (item) =>
        item.parent === parent &&
        item.runId === runId &&
        item.requestId === requestId,
    );
    if (receipt !== undefined) {
      if (receipt.stageId !== stageId)
        return Promise.reject(
          new ResearchError(
            "REQUEST_CONFLICT",
            "Stage request ID was already used for a different stage.",
          ),
        );
      return receipt.result;
    }
    const definition = this.runs.readDefinition(runId);
    const stage = definition.stages?.find((entry) => entry.id === stageId);
    if (stage === undefined)
      return Promise.reject(
        new ResearchError("INVALID_INPUT", "Unknown research stage."),
      );
    const definitions = stage.taskIds.map((id) =>
      definition.tasks.find((task) => task.id === id)!,
    );
    if (definitions.some((task) => task.executor.kind !== "role"))
      return Promise.reject(
        new ResearchError(
          "INVALID_INPUT",
          "Only role stages can be dispatched; use the service tool for summaries and finalization.",
        ),
      );
    const result = this.#afterStops(runId, stage.taskIds, signal, async () => {
      const ready = new Set(this.runs.view({ runId }).readyTasks);
      const requests = stage.taskIds.map((taskId) => ({
        taskId,
        requestId: JSON.stringify(["stage", stageId, requestId, taskId]),
      }));
      const replays = requests.map((request) =>
        this.runs.hasClaimReceipt(
          { runId, identity: parent.id },
          JSON.stringify(["dispatch", request.requestId]),
        ),
      );
      if (replays.some(Boolean) && !replays.every(Boolean))
        throw new ResearchError(
          "STALE_ATTEMPT",
          "The previous batch was interrupted while claiming tasks. Confirm interruption and recover before dispatching a new batch.",
        );
      if (
        !replays.every(Boolean) &&
        !stage.taskIds.every((taskId) => ready.has(taskId))
      )
        throw new ResearchError(
          "TASK_NOT_READY",
          "All roles in the stage must be ready for batch dispatch; use stock_dispatch_task for a single-sided revision.",
        );
      this.runs.recordStageDispatch(operation, stageId, requestId);
      const outcomes = await Promise.allSettled(
        requests.map(({ taskId, requestId: taskRequestId }) =>
          this.#startRole(parent, runId, taskId, taskRequestId, signal),
        ),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Stage dispatch failed after all child executions settled.",
          { cause: failures[0] },
        );
      return {
        runId,
        stageId,
        results: outcomes.map(
          (outcome) =>
            (outcome as PromiseFulfilledResult<DispatchResult>).value,
        ),
      };
    }).finally(() => {
      const index = this.#stageReceipts.findIndex(
        (receipt) =>
          receipt.parent === parent &&
          receipt.runId === runId &&
          receipt.requestId === requestId,
      );
      if (index !== -1) this.#stageReceipts.splice(index, 1);
    });
    this.#stageReceipts.push({ parent, runId, requestId, stageId, result });
    return result;
  }

  followup(
    parent: Agent,
    runId: string,
    taskId: string,
    message: string,
    requestId: string,
    resumeSearch: boolean,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const payload = JSON.stringify([taskId, message, resumeSearch]);
    const receipt = this.#followupReceipts.find(
      (item) =>
        item.parent === parent &&
        item.runId === runId &&
        item.requestId === requestId,
    );
    if (receipt !== undefined) {
      if (receipt.payload !== payload)
        return Promise.reject(
          new ResearchError(
            "REQUEST_CONFLICT",
            "Follow-up request ID was already used with different input.",
          ),
        );
      return receipt.result;
    }
    const result = this.#afterStops(runId, taskId, signal, async () => {
      const session = this.#roleSessions.get(JSON.stringify([runId, taskId]));
      const task = this.runs
        .view({ runId })
        .tasks.find((item) => item.taskId === taskId);
      if (
        session === undefined ||
        session.parent !== parent ||
        session.provision.followup === undefined ||
        task?.attempt !== session.attempt ||
        task.status !== "succeeded" ||
        this.#active.has(
          attemptKey(runId, { taskId, attempt: session.attempt }),
        )
      )
        throw new ResearchError(
          "STALE_ATTEMPT",
          "Follow-up requires this host's latest settled successful role session and its original parent.",
        );
      const operation = { runId, identity: parent.id };
      await this.redo(
        operation,
        taskId,
        JSON.stringify(["followup-redo", requestId]),
        message,
      );
      signal.throwIfAborted();
      this.runs.resume(
        operation,
        {
          resolvedReasonIds: [],
          instructions: [{ taskId, instruction: message }],
        },
        JSON.stringify(["followup-resume", requestId]),
      );
      return this.#afterStops(runId, taskId, signal, () =>
        this.#startRole(
          parent,
          runId,
          taskId,
          JSON.stringify(["followup", requestId]),
          signal,
          { session, message, resumeSearch },
        ),
      );
    });
    this.#followupReceipts.push({ parent, runId, requestId, payload, result });
    return result;
  }

  releaseRun(runId: string): void {
    for (const key of this.#roleSessions.keys())
      if ((JSON.parse(key) as string[])[0] === runId)
        this.#roleSessions.delete(key);
  }

  async #startRole(
    parent: Agent,
    runId: string,
    taskId: string,
    requestId: string,
    signal: AbortSignal,
    continuation?: {
      session: RoleSession;
      message: string;
      resumeSearch: boolean;
    },
  ): Promise<DispatchResult> {
    const context = this.runs.dispatchForCall(
      { runId, identity: parent.id },
      taskId,
      JSON.stringify(["dispatch", requestId]),
    );
    const key = attemptKey(runId, context.claim);
    const existing = this.#active.get(key);
    if (existing !== undefined) return existing.result;
    if (context.attempt.status !== "running")
      return this.#result(context.claim);
    if (context.replayed)
      throw new ResearchError(
        "STALE_ATTEMPT",
        "The running attempt has no execution owned by this host. Confirm interruption before recovering it.",
      );

    const controller = new AbortController();
    let resolveDrain!: (failures: unknown[]) => void;
    const drained = new Promise<unknown[]>((resolve) => {
      resolveDrain = resolve;
    });
    // Publish ownership before asynchronous provisioning can race redo/cancel.
    const result = Promise.resolve()
      .then(() =>
        this.#execute(
          parent,
          context,
          signal,
          controller.signal,
          resolveDrain,
          continuation,
        ),
      )
      .finally(() => this.#active.delete(key));
    this.#active.set(key, {
      runId,
      taskId,
      attempt: context.claim.attempt,
      controller,
      result,
      drained,
    });
    return result;
  }

  makeDigest(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCommitResult> {
    return this.#afterStops(operation.runId, taskId, signal, () =>
      this.digests.makeDigest(operation, taskId, requestId, signal),
    );
  }

  async redo(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    reason: string | null = null,
  ): Promise<RedoTaskResult> {
    let result: RedoTaskResult;
    try {
      result = this.runs.redo(operation, taskId, requestId, reason);
    } catch (cause) {
      return this.#controlFailure(operation.runId, cause);
    }
    for (const task of result.affectedTasks)
      this.#roleSessions.delete(JSON.stringify([operation.runId, task]));
    await this.#duringStop(operation.runId, result.affectedTasks, () =>
      this.#stopTargets(operation.runId, result.stopAttempts),
    );
    return result;
  }

  async cancel(
    operation: RunOperation,
    requestId: string,
  ): Promise<CancelRunResult> {
    let result: CancelRunResult;
    try {
      result = this.runs.cancel(operation, requestId);
    } catch (cause) {
      return this.#controlFailure(operation.runId, cause);
    }
    await this.#duringStop(operation.runId, null, () =>
      this.#stopTargets(operation.runId, result.stopAttempts, true),
    );
    return result;
  }

  /** The user explicitly confirms loss; local live execution contradicts it. */
  recoverInterrupted(
    operation: RunOperation,
    targets: readonly AttemptTarget[],
    requestId: string,
  ): RecoverAttemptsResult {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Research dispatch is closed.");
    const view = this.runs.view(operation);
    for (const target of targets) {
      const task = view.tasks.find(
        (task) =>
          task.taskId === target.taskId && task.attempt === target.attempt,
      );
      const sessionId =
        task === undefined
          ? null
          : this.runs.readAttempt({ ...operation, ...target }).sessionId;
      if (
        this.#active.has(attemptKey(operation.runId, target)) ||
        this.digests.isExecuting(operation.runId, target) ||
        (sessionId !== null &&
          this.ctx.agents.get(SessionId(sessionId)) !== undefined)
      )
        throw new ResearchError(
          "STALE_ATTEMPT",
          "The host still owns this attempt; it cannot be recovered as interrupted.",
        );
    }
    return this.runs.recoverInterrupted(
      operation,
      targets,
      {
        code: "HOST_INTERRUPTED",
        message:
          "The user confirmed that the previous host execution was lost.",
      },
      requestId,
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unlistenParent();
    this.#roleSessions.clear();
    this.#followupReceipts.length = 0;
    this.#stageReceipts.length = 0;
    await finishStops([
      this.#stop([...this.#active.values()]),
      this.digests.close(),
    ]);
  }

  async #execute(
    parent: Agent,
    context: RoleDispatchContext,
    callerSignal: AbortSignal,
    ownerSignal: AbortSignal,
    resolveDrain: (failures: unknown[]) => void,
    continuation?: {
      session: RoleSession;
      message: string;
      resumeSearch: boolean;
    },
  ): Promise<DispatchResult> {
    const signal = AbortSignal.any([callerSignal, ownerSignal]);
    const { claim } = context;
    const childId = continuation?.session.childId ?? SessionId(randomUUID());
    const operation: TaskOperation = {
      ...claim,
      identity: parent.id,
      sessionId: null,
    };
    const cleanupFailures: unknown[] = [];
    let activation: SubagentActivation | undefined;
    let disposal: Promise<PromiseSettledResult<void>[]> | undefined;
    let release: (() => void) | undefined;
    let childFailure: TaskFailure | undefined;
    let provision: RoleProvision | undefined;
    const dispose = () => {
      if (activation !== undefined && disposal === undefined)
        disposal = Promise.allSettled([activation.dispose()]);
    };
    const abort = () => {
      dispose();
    };
    signal.addEventListener("abort", abort, { once: true });
    let execution: PromiseSettledResult<SubagentResult>;
    try {
      try {
        signal.throwIfAborted();
        provision =
          continuation === undefined
            ? this.prepare(context, parent)
            : continuation.session.provision.followup!(context, {
                resumeSearch: continuation.resumeSearch,
              });
        const currentProvision = provision;
        const models = readResearchModels(this.runs, claim.runId);
        const setup = this.sessions.setup(
          {
            kind: "task",
            runId: claim.runId,
            taskId: claim.taskId,
            attempt: claim.attempt,
          },
          provision.tools,
        );
        release = this.sessions.reserve(childId, async (agentCtx, agent) => {
          if (models !== undefined) {
            // The SDK merges omitted fields from the live parent; this run owns its exact model snapshot.
            Object.assign(agent.options, models.research);
            if (models.research.reasoningEffort === undefined)
              delete agent.options.reasoningEffort;
            if (models.research.maxTokens === undefined)
              delete agent.options.maxTokens;
          }
          if (currentProvision.systemPrompt !== undefined)
            agentCtx.systemPrompt.section({
              name: ROLE_PROMPT_SECTION,
              order: 0,
              text: currentProvision.systemPrompt,
              complete: true,
              interpolate: false,
            });
          const prepared = await setup(agentCtx, agent);
          prepared?.commit();
          // Local spawn omits diagnostic from its result; retain the SDK error event.
          agentCtx.on("agent/error", ({ error }) => {
            childFailure = {
              ...executionFailure(error, signal),
              message: errorChain(error),
            };
          });
          operation.sessionId = agent.id;
          this.runs.bindTaskSession({ ...operation, sessionId: agent.id });
          observeModelCalls(agent, operation, "role");
        });
        activation =
          continuation === undefined
            ? await this.ctx.subagents.startActivation({
                provider: "spawn",
                childId,
                label: `${claim.taskId} #${claim.attempt}`,
                delivery: "caller",
                signal,
                request: {
                  parent,
                  ...(models === undefined
                    ? {}
                    : { agentOptions: models.research }),
                  ...(provision.agentPreset === undefined
                    ? {}
                    : { agentPreset: provision.agentPreset }),
                  prompt: provision.prompt,
                },
              })
            : await continueChild(
                this.ctx,
                parent,
                childId,
                [
                  {
                    type: "text",
                    text: `${continuation.message}\nUse the existing conversation to complete the requested additions or revisions, check the draft and submit it. ${continuation.resumeSearch ? "The primary agent has resumed search. Previous usage and limits remain; each over-budget search requires user approval." : "Search pause and usage remain unchanged."}`,
                  },
                ],
                signal,
              );
        if (signal.aborted) dispose();
        execution = { status: "fulfilled", value: await activation.result };
      } catch (reason) {
        execution = { status: "rejected", reason };
      } finally {
        dispose();
        if (disposal !== undefined) {
          const [settled] = await disposal;
          if (settled!.status === "rejected")
            cleanupFailures.push(settled!.reason);
        }
        signal.removeEventListener("abort", abort);
        release?.();
      }

      let failure: TaskFailure;
      if (execution.status === "rejected") {
        failure = executionFailure(execution.reason, signal);
      } else if (
        execution.value.stopReason === "error" &&
        childFailure !== undefined
      ) {
        failure = childFailure;
      } else if (execution.value.stopReason === "completed") {
        failure = {
          code: "NO_ARTIFACT",
          message:
            "The role finished without submitting its required artifacts.",
        };
      } else {
        failure = {
          code: `SUBAGENT_${execution.value.stopReason.toUpperCase()}`,
          message:
            execution.value.diagnostic ??
            `The role stopped with ${execution.value.stopReason}.`,
        };
      }
      try {
        this.runs.failServiceAttempt(operation, failure, "dispatch-end");
      } catch (recording) {
        cleanupFailures.push(recording);
        throw new ResearchError(
          "STORAGE_FAILED",
          "Could not record role execution failure.",
          {
            cause: new AggregateError(
              [
                ...(execution.status === "rejected" ? [execution.reason] : []),
                ...cleanupFailures,
              ],
              "Role execution and state recording failed.",
              { cause: recording },
            ),
          },
        );
      }
      if (cleanupFailures.length > 0)
        throw new AggregateError(
          [
            ...(execution.status === "rejected" ? [execution.reason] : []),
            ...cleanupFailures,
          ],
          "Role execution cleanup failed.",
          { cause: cleanupFailures[0] },
        );
      if (execution.status === "rejected") throw execution.reason;
      const result = this.#result(claim);
      if (
        result.status === "succeeded" &&
        provision !== undefined &&
        !this.#closed &&
        !signal.aborted &&
        this.ctx.agents.get(parent.id) === parent
      )
        this.#roleSessions.set(JSON.stringify([claim.runId, claim.taskId]), {
          parent,
          childId,
          provision,
          attempt: claim.attempt,
        });
      return result;
    } finally {
      resolveDrain(cleanupFailures);
    }
  }

  #result(
    claim: Pick<TaskOperation, "runId" | "taskId" | "attempt">,
  ): DispatchResult {
    const attempt = this.runs.readAttempt(claim);
    return {
      runId: claim.runId,
      taskId: claim.taskId,
      attempt: claim.attempt,
      status: attempt.status,
      sessionId: attempt.sessionId,
      refs: attempt.outputRefs,
      failure: attempt.failure,
    };
  }

  async #stopTargets(
    runId: string,
    targets: readonly AttemptTarget[],
    cancelled = false,
  ): Promise<void> {
    if (cancelled) this.releaseRun(runId);
    const keys = new Set(targets.map((target) => attemptKey(runId, target)));
    const owned = [...this.#active.values()].filter(
      (owner) =>
        owner.runId === runId &&
        (cancelled ||
          keys.has(attemptKey(runId, owner)) ||
          this.runs.readAttempt(owner).status === "invalidated"),
    );
    await finishStops([
      this.#stop(owned),
      this.digests.stop(runId, targets, cancelled),
    ]);
  }

  async #controlFailure(runId: string, cause: unknown): Promise<never> {
    try {
      // Publication can precede a projection/sync error; stop from canonical state.
      await this.#duringStop(runId, null, async () => {
        const cancelled = this.runs.view({ runId }).status === "cancelled";
        await this.#stopTargets(runId, [], cancelled);
      });
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Run control and execution release failed.",
        { cause: cleanup },
      );
    }
    throw cause;
  }

  async #afterStops<Result>(
    runId: string,
    taskId: string | readonly string[],
    signal: AbortSignal | undefined,
    start: () => Promise<Result>,
  ): Promise<Result> {
    this.#admit(signal);
    while (true) {
      const barriers = new Set([
        ...(this.#barriers.get(JSON.stringify([runId, null])) ?? []),
        ...(typeof taskId === "string" ? [taskId] : taskId).flatMap((id) => [
          ...(this.#barriers.get(JSON.stringify([runId, id])) ?? []),
        ]),
      ]);
      // Admission and claim stay in the same synchronous segment.
      if (barriers.size === 0) return start();
      const outcomes = await Promise.all(barriers);
      this.#admit(signal);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Research stop barriers failed.", {
          cause: failures[0],
        });
    }
  }

  async #duringStop(
    runId: string,
    taskIds: readonly string[] | null,
    stop: () => Promise<void>,
  ): Promise<void> {
    const keys =
      taskIds === null
        ? [JSON.stringify([runId, null])]
        : taskIds.map((taskId) => JSON.stringify([runId, taskId]));
    let finish!: (result: PromiseSettledResult<void>) => void;
    const barrier = new Promise<PromiseSettledResult<void>>((resolve) => {
      finish = resolve;
    });
    for (const key of keys) {
      let barriers = this.#barriers.get(key);
      if (barriers === undefined) {
        barriers = new Set();
        this.#barriers.set(key, barriers);
      }
      barriers.add(barrier);
    }
    try {
      await stop();
      finish({ status: "fulfilled", value: undefined });
    } catch (reason) {
      finish({ status: "rejected", reason });
      throw reason;
    } finally {
      for (const key of keys) {
        const barriers = this.#barriers.get(key)!;
        barriers.delete(barrier);
        if (barriers.size === 0) this.#barriers.delete(key);
      }
    }
  }

  #admit(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Research dispatch is closed.");
  }

  async #stop(owned: readonly OwnedAttempt[]): Promise<void> {
    for (const owner of owned)
      owner.controller.abort(
        new DOMException("Research execution stopped.", "AbortError"),
      );
    const failures = (
      await Promise.all(owned.map((owner) => owner.drained))
    ).flat();
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Could not release research executions.",
        { cause: failures[0] },
      );
  }
}
