import type { ArtifactPayloads } from "../../contracts/artifact-payloads.js";
import type { ArtifactRef } from "../../contracts/data.js";
import type { CollectionAccess } from "../../contracts/collection.js";
import type { TaskDefinition } from "../../contracts/workflow.js";
import { ExecutionStopped, ResearchError } from "../../contracts/errors.js";
import type { RunCommands, RunReader } from "../../contracts/run-access.js";
import type {
  ArtifactCommitResult,
  AttemptTarget,
  RunOperation,
  TaskOperation,
} from "../../contracts/runs.js";

interface OwnedCollection {
  operation: TaskOperation;
  controller: AbortController;
  signal: AbortSignal;
  result: Promise<ArtifactCommitResult>;
}

/** Own collection attempts; RunService alone publishes their immutable outputs. */
export class CollectionRunService {
  readonly #pending = new Map<string, OwnedCollection>();
  #closed = false;

  constructor(
    private readonly runs: Pick<
      RunReader,
      "readAttempt" | "readArtifact" | "replaySnapshot"
    > &
      Pick<
        RunCommands,
        | "claimServiceForCall"
        | "serviceForCall"
        | "commitArtifact"
        | "failServiceAttempt"
      >,
    private readonly collection: Pick<CollectionAccess, "collectNode">,
  ) {}

  async collect(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCommitResult> {
    this.#admit(signal);
    const key = JSON.stringify([
      operation.runId,
      operation.identity,
      taskId,
      requestId,
    ]);
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing.result;
    const stopping = [...this.#pending.values()].filter(
      (entry) =>
        entry.operation.runId === operation.runId &&
        entry.operation.taskId === taskId &&
        (entry.signal.aborted ||
          ["cancelled", "invalidated"].includes(
            this.runs.readAttempt(entry.operation).status,
          )),
    );
    if (stopping.length > 0) {
      await this.#stopOwned(stopping);
      this.#admit(signal);
      const shared = this.#pending.get(key);
      if (shared !== undefined) return shared.result;
    }
    const { claim, replayed } = this.runs.claimServiceForCall(
      operation,
      taskId,
      "collection",
      JSON.stringify(["collection", taskId, requestId]),
    );
    const current: TaskOperation = {
      ...claim,
      identity: operation.identity,
      sessionId: null,
    };
    const call = this.runs.serviceForCall(
      current,
      requestId,
      "commit_artifact",
    );
    if (call.result !== null) return call.result;
    if (replayed)
      throw new ResearchError(
        "STALE_ATTEMPT",
        "The running collection has no execution owned by this service. Confirm interruption before recovering it.",
      );
    const definition = call.context.definition.tasks.find(
      ({ id }) => id === taskId,
    )!;
    const executor = definition.executor as Extract<
      TaskDefinition["executor"],
      { service: "collection" }
    >;
    const previous = call.context.tasks
      .find((task) => task.taskId === taskId)!
      .attempts.slice(0, -1)
      .findLast((attempt) => attempt.outputRefs.length > 0);
    const replay = this.runs.replaySnapshot(operation.runId);
    const capturedFrom =
      previous?.outputRefs[0] ??
      replay?.tasks.find((task) => task.taskId === taskId)?.outputRefs[0] ??
      null;
    const controller = new AbortController();
    const active =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]);
    const result = Promise.resolve()
      .then(async () => {
        try {
          active.throwIfAborted();
          if (replay !== null && capturedFrom === null)
            throw new ResearchError(
              "DATA_INSUFFICIENT",
              `No fixed collection output is available for replay task ${taskId}.`,
            );
          const snapshot =
            capturedFrom === null
              ? await this.collection.collectNode(
                  call.context.scope,
                  executor.node,
                  active,
                )
              : structuredClone(this.#captured(capturedFrom).snapshot);
          active.throwIfAborted();
          if (
            executor.node === "required" &&
            !snapshot.packets.some(({ id }) => id === "market.daily")
          )
            throw new ResearchError(
              "DATA_INSUFFICIENT",
              "Daily market data is required.",
            );
          return this.runs.commitArtifact(
            current,
            [
              {
                kind: "collection",
                title: `固定数据：${executor.node}`,
                body: `${snapshot.packets.length} 张固定表，${snapshot.failures.length} 项来源诊断。`,
                inputRefs: claim.inputRefs,
                claims: [],
                payload: { snapshot, capturedFrom },
              },
            ],
            requestId,
          );
        } catch (cause) {
          try {
            this.runs.failServiceAttempt(
              current,
              {
                code:
                  cause instanceof ResearchError
                    ? cause.code
                    : active.aborted
                      ? "CANCELLED"
                      : "COLLECTION_FAILED",
                message: cause instanceof Error ? cause.message : String(cause),
              },
              JSON.stringify(["collection-fail", requestId]),
            );
          } catch (recording) {
            throw new AggregateError(
              [cause, recording],
              "Collection execution and failure recording failed.",
              { cause: recording },
            );
          }
          throw cause;
        }
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, {
      operation: current,
      controller,
      signal: active,
      result,
    });
    return result;
  }

  #captured(ref: ArtifactRef): ArtifactPayloads["collection"] {
    return this.runs.readArtifact(ref).content
      .payload as ArtifactPayloads["collection"];
  }

  async stop(
    runId: string,
    targets: readonly AttemptTarget[],
    cancelled = false,
  ): Promise<void> {
    const owned = [...this.#pending.values()].filter(
      ({ operation }) =>
        operation.runId === runId &&
        (cancelled ||
          targets.some(
            ({ taskId, attempt }) =>
              taskId === operation.taskId && attempt === operation.attempt,
          ) ||
          ["cancelled", "invalidated"].includes(
            this.runs.readAttempt(operation).status,
          )),
    );
    await this.#stopOwned(owned);
  }

  isExecuting(runId: string, target: AttemptTarget): boolean {
    return [...this.#pending.values()].some(
      ({ operation }) =>
        operation.runId === runId &&
        operation.taskId === target.taskId &&
        operation.attempt === target.attempt,
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#stopOwned([...this.#pending.values()]);
  }

  #admit(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#closed)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Collection execution is closed.",
      );
  }

  async #stopOwned(owned: readonly OwnedCollection[]): Promise<void> {
    for (const entry of owned)
      entry.controller.abort(
        new ExecutionStopped("Collection execution stopped."),
      );
    const settled = await Promise.allSettled(owned.map(({ result }) => result));
    const failures = settled.flatMap((result, index) =>
      result.status === "rejected" &&
      result.reason !== owned[index]!.controller.signal.reason
        ? [result.reason as unknown]
        : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Could not release collection executions.",
      );
  }
}
