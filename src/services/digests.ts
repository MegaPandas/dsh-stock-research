import type { DigestModelInput, GenerateDigest } from "../contracts/digests.js";
import { ResearchError } from "../contracts/errors.js";
import type { ResearchScope } from "../contracts/data.js";
import type {
  ArtifactCommitResult,
  AttemptTarget,
  ClaimResult,
  RunOperation,
  TaskInstructionSnapshot,
  TaskOperation,
} from "../contracts/runs.js";
import { ArtifactInputs } from "./artifact-inputs.js";
import type { ArtifactService } from "./artifacts.js";
import { assembleDigest } from "./digest-draft.js";
import { digestNumbers, digestRisks } from "./digest-inputs.js";
import type { RunService } from "./runs.js";

interface PendingDigest {
  operation: TaskOperation;
  controller: AbortController;
  result: Promise<ArtifactCommitResult>;
  drained: Promise<void>;
  failures: unknown[];
}

export class DigestService {
  private readonly pending = new Map<string, PendingDigest>();
  private closed = false;
  constructor(
    private readonly runs: RunService,
    private readonly artifacts: ArtifactService,
    private readonly generate: GenerateDigest,
  ) {}

  async makeDigest(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCommitResult> {
    this.admit(signal);
    const key = JSON.stringify([
      operation.runId,
      operation.identity,
      taskId,
      requestId,
    ]);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing.result;
    const stopping = [...this.pending.values()].filter(
      (entry) =>
        entry.operation.runId === operation.runId &&
        entry.operation.taskId === taskId &&
        entry.controller.signal.aborted,
    );
    if (stopping.length > 0) {
      await this.stopOwned(stopping);
      this.admit(signal);
      const shared = this.pending.get(key);
      if (shared !== undefined) return shared.result;
    }
    const { claim: claimed, replayed } = this.runs.claimServiceForCall(
      operation,
      taskId,
      "digest",
      JSON.stringify(["digest", taskId, requestId]),
    );
    const taskOperation: TaskOperation = {
      ...claimed,
      identity: operation.identity,
      sessionId: null,
    };
    const call = this.runs.serviceForCall(
      taskOperation,
      requestId,
      "commit_artifact",
    );
    if (call.result !== null) return call.result;
    if (replayed)
      throw new ResearchError(
        "STALE_ATTEMPT",
        "The running digest has no execution owned by this service. Confirm interruption before recovering it.",
      );

    const controller = new AbortController();
    const modelSignal =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]);
    const failures: unknown[] = [];
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = Promise.resolve()
      .then(() =>
        this.execute(
          taskOperation,
          claimed,
          call.context.scope,
          requestId,
          modelSignal,
          failures,
        ),
      )
      .finally(() => {
        this.pending.delete(key);
        finish();
      });
    this.pending.set(key, {
      operation: taskOperation,
      controller,
      result,
      drained,
      failures,
    });
    return result;
  }

  async stop(
    runId: string,
    targets: readonly AttemptTarget[],
    cancelled = false,
  ): Promise<void> {
    const owned = [...this.pending.values()].filter(
      ({ operation }) =>
        operation.runId === runId &&
        (cancelled ||
          targets.some(
            (target) =>
              target.taskId === operation.taskId &&
              target.attempt === operation.attempt,
          ) ||
          this.runs.readAttempt(operation).status === "invalidated"),
    );
    await this.stopOwned(owned);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopOwned([...this.pending.values()]);
  }

  isExecuting(runId: string, target: AttemptTarget): boolean {
    return [...this.pending.values()].some(
      ({ operation }) =>
        operation.runId === runId &&
        operation.taskId === target.taskId &&
        operation.attempt === target.attempt,
    );
  }

  private async execute(
    taskOperation: TaskOperation,
    claimed: ClaimResult,
    scope: ResearchScope,
    requestId: string,
    signal: AbortSignal,
    failures: unknown[],
  ): Promise<ArtifactCommitResult> {
    let published = false;
    try {
      signal.throwIfAborted();
      const inputs = new ArtifactInputs(this.runs);
      const roots = claimed.inputRefs.map((ref) => inputs.artifact(ref));
      const versions = inputs.closure(claimed.inputRefs);
      const context: DigestModelInput = {
        scope,
        taskId: taskOperation.taskId,
        instructionVersion: claimed.instructionVersion,
        instruction:
          claimed.instructionRef === undefined
            ? null
            : this.runs.readInput<TaskInstructionSnapshot>(
                taskOperation.runId,
                claimed.instructionRef,
              ).instruction,
        artifacts: roots,
        reports: versions,
        references: versions.map((version) => version.ref),
        numbers: digestNumbers(versions, inputs),
        risks: digestRisks(versions),
        gaps: inputs.reportedGaps(versions),
      };
      return await this.generate(
        structuredClone(context),
        signal,
        structuredClone(taskOperation),
        (draft) => {
          signal.throwIfAborted();
          const content = assembleDigest(draft, context);
          const result = this.artifacts.submitArtifact(
            taskOperation,
            [content],
            requestId,
          );
          published = true;
          return result;
        },
      );
    } catch (cause) {
      if (published) throw cause;
      const failure = {
        code:
          cause instanceof ResearchError
            ? cause.code
            : signal.aborted
              ? "CANCELLED"
              : "MODEL_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      try {
        this.runs.failServiceAttempt(
          taskOperation,
          failure,
          JSON.stringify(["digest-fail", requestId]),
        );
      } catch (recording) {
        failures.push(recording);
        throw new ResearchError(
          "STORAGE_FAILED",
          "Could not record digest execution failure.",
          {
            cause: new AggregateError(
              [cause, recording],
              "Digest execution and state recording failure.",
              { cause: recording },
            ),
          },
        );
      }
      throw cause;
    }
  }

  private admit(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed)
      throw new ResearchError("ACCESS_DENIED", "Digest execution is closed.");
  }

  private async stopOwned(owned: readonly PendingDigest[]): Promise<void> {
    for (const entry of owned)
      entry.controller.abort(
        new DOMException("Digest execution stopped.", "AbortError"),
      );
    await Promise.all(owned.map((entry) => entry.drained));
    const failures = owned.flatMap((entry) => entry.failures);
    if (failures.length > 0)
      throw new ResearchError(
        "STORAGE_FAILED",
        "Could not finish digest failure recording.",
        {
          cause: new AggregateError(
            failures,
            "Digest execution recording failed.",
          ),
        },
      );
  }
}
