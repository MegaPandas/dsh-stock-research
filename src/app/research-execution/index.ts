import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  JobHandle,
  JobId,
  JobOutcome,
  JobRegistry,
} from "@deepseek-ai/dsh-jobs";
import type { RunReader } from "../../contracts/run-access.js";
import type { CollectionProgress } from "../../contracts/collection.js";
import type {
  CollectionCounts,
  ResearchIdentity,
} from "../../contracts/research-progress.js";
import type {
  CancelRunResult,
  RunOperation,
  RunView,
} from "../../contracts/runs.js";
import { ResearchError } from "../../contracts/errors.js";
import type {
  ResearchHandle,
  ResearchObservation,
} from "../research-actions.js";
import { serializeJson } from "../../json/serialize.js";
import { failureDetail } from "./progress.js";
import {
  RESEARCH_JOB_KIND,
  RESEARCH_STEP_JOB_KIND,
} from "../../contracts/research-progress.js";
import type {} from "./job.js";
import { appendResearchRecord } from "./output.js";
import {
  collectionJobRecords,
  researchJobOutcome,
  researchJobView,
  type ResearchPreparationStatus,
} from "./view.js";

interface Operation {
  controller: AbortController;
  work: Promise<JobOutcome>;
}
interface ResearchExecution {
  owner: Agent;
  job: JobHandle;
  completion: {
    promise: Promise<JobOutcome>;
    resolve(outcome: JobOutcome): void;
  };
  publishedProgress?: string;
  identity?: ResearchIdentity;
  collection?: CollectionCounts;
  outcome?: JobOutcome;
  runId?: string;
  preparationStatus: ResearchPreparationStatus;
  release: () => void;
  resourcesReleased: boolean;
  finished: boolean;
  deliverySettled: boolean;
  terminal: boolean;
  errors: unknown[];
  cancellation?: Promise<void>;
  cancelling: boolean;
  operations: Map<JobId, Operation>;
}
export interface ResearchExecutionPorts {
  jobs: Pick<JobRegistry, "start" | "get" | "kill">;
  runs: Pick<RunReader, "view">;
  cancelRun(
    operation: RunOperation,
    requestId: string,
  ): Promise<CancelRunResult>;
  releaseRun(runId: string): void;
  holdActivity(): () => void;
  isOwnerLive(owner: Agent): boolean;
  isClosing(): boolean;
  onError(owner: Agent, handle: ResearchHandle, detail: string): void;
}
function researchCompletion(): ResearchExecution["completion"] {
  let resolve!: (outcome: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Owns background Jobs and resources; canonical mutations belong to callers. */
export class ResearchExecutions {
  readonly #executions = new Set<ResearchExecution>();
  readonly #runs = new Map<string, ResearchExecution>();
  readonly #jobs = new Map<string, ResearchExecution>();
  readonly #pending = new Set<Promise<unknown>>();
  constructor(private readonly ports: ResearchExecutionPorts) {}

  ownerOf(runId: string): Agent | undefined {
    return this.#runs.get(runId)?.owner;
  }
  running(runId: string): boolean {
    const research = this.#runs.get(runId);
    return (
      research !== undefined &&
      !research.terminal &&
      !research.finished &&
      !research.cancelling
    );
  }
  settled(runId: string): Promise<void> {
    return (
      this.#runs.get(runId)?.completion.promise.then(() => {}) ??
      Promise.resolve()
    );
  }
  handleFor(runId: string): ResearchHandle {
    return { jobId: this.#runs.get(runId)!.job.id };
  }

  start(
    owner: Agent,
    selection: { label: string; identity?: ResearchIdentity; runId?: string },
    callerSignal: AbortSignal,
    action: (
      signal: AbortSignal,
      attach: (runId: string) => void,
      onProgress: (progress: CollectionProgress) => void,
    ) => Promise<void>,
  ): ResearchHandle {
    return this.#launch(
      owner,
      undefined,
      selection.label,
      callerSignal,
      (research, job, signal) => {
        return action(
          signal,
          (runId) => {
            research.runId = runId;
            this.#runs.set(runId, research);
          },
          (progress) => {
            const {
              completed,
              total,
              succeeded,
              failed,
              cacheHits,
              cacheMisses,
              current,
            } = progress;
            research.collection = {
              completed,
              total,
              succeeded,
              failed,
              cacheHits,
              cacheMisses,
              ...(current === undefined ? {} : { current }),
            };
            this.#publish(research);
            for (const record of collectionJobRecords(progress))
              appendResearchRecord(job, record);
          },
        );
      },
      selection,
    );
  }

  launch(
    runId: string,
    label: string,
    callerSignal: AbortSignal,
    action: (signal: AbortSignal) => Promise<unknown>,
  ): ResearchHandle {
    const research = this.#runs.get(runId)!;
    if (research.terminal || research.finished || research.cancelling)
      throw new ResearchError(
        "TASK_NOT_READY",
        "Research execution is no longer accepting work.",
      );
    return this.#launch(
      research.owner,
      research,
      label,
      callerSignal,
      (_research, _job, signal) => action(signal),
    );
  }

  read(jobId: string, owner: Agent): ResearchObservation {
    const research = this.#owned(jobId, owner);
    const view =
      research.runId === undefined
        ? undefined
        : this.ports.runs.view({ runId: research.runId });
    return {
      job: this.ports.jobs.get(jobId as JobId, owner.id),
      ...(research.runId === undefined ? {} : { runId: research.runId }),
      ...(view === undefined ? {} : { view }),
    };
  }
  #owned(jobId: string, owner: Agent): ResearchExecution {
    const research = this.#jobs.get(jobId);
    if (research === undefined || research.owner !== owner)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Research Job is not owned by this Agent.",
      );
    return research;
  }
  cancelJob(jobId: string, owner: Agent, requestId: string): Promise<void> {
    const research = this.#owned(jobId, owner);
    if (
      research.cancellation === undefined &&
      research.runId !== undefined &&
      this.#runs.get(research.runId) !== research
    )
      throw new ResearchError(
        "STALE_ATTEMPT",
        "Use the current research handle to cancel its execution.",
      );
    return this.#requestCancel(research, requestId);
  }
  cancel(runId: string, requestId: string): Promise<void> {
    return this.#requestCancel(this.#runs.get(runId)!, requestId);
  }
  publish(runId: string, view?: RunView): void {
    const research = this.#runs.get(runId);
    if (research !== undefined && !research.finished)
      this.#publish(research, view);
  }

  #launch(
    owner: Agent,
    previous: ResearchExecution | undefined,
    label: string,
    callerSignal: AbortSignal,
    action: (
      research: ResearchExecution,
      job: JobHandle,
      signal: AbortSignal,
    ) => Promise<unknown>,
    selection?: { identity?: ResearchIdentity; runId?: string },
  ): ResearchHandle {
    callerSignal.throwIfAborted();
    const id = this.ports.jobs.start({
      kind: previous === undefined ? RESEARCH_JOB_KIND : RESEARCH_STEP_JOB_KIND,
      label,
      owner: owner.id,
      run: (job) => {
        const research: ResearchExecution = previous ?? {
          owner,
          job,
          completion: researchCompletion(),
          preparationStatus: "preparing",
          release: this.ports.holdActivity(),
          resourcesReleased: false,
          finished: false,
          deliverySettled: false,
          terminal: false,
          errors: [],
          cancelling: false,
          operations: new Map(),
        };
        if (selection !== undefined) {
          if (selection.identity !== undefined)
            research.identity = selection.identity;
          if (selection.runId !== undefined) {
            research.runId = selection.runId;
            this.#runs.set(selection.runId, research);
          }
        }
        this.#executions.add(research);
        this.#jobs.set(job.id, research);
        const controller = new AbortController();
        const work = Promise.resolve().then(async (): Promise<JobOutcome> => {
          let outcome: JobOutcome;
          try {
            controller.signal.throwIfAborted();
            job.updateProgress(
              previous === undefined ? "准备采集数据" : "执行研究任务",
            );
            const result = await action(research, job, controller.signal);
            outcome = {
              status: "completed",
              ...(result === undefined
                ? {}
                : { result: serializeJson(result) }),
            };
          } catch (cause) {
            if (
              controller.signal.aborted &&
              cause === controller.signal.reason
            ) {
              outcome = { status: "killed", detail: failureDetail(cause) };
            } else {
              this.#error(research, job, cause);
              outcome = { status: "failed", detail: failureDetail(cause) };
            }
            if (research.runId === undefined)
              research.preparationStatus =
                outcome.status === "killed" ? "cancelled" : "failed";
          }
          research.operations.delete(job.id);
          if (research.errors.length === 0)
            try {
              this.#publish(research);
            } catch (cause) {
              this.#error(research, job, cause);
              outcome = { status: "failed", detail: failureDetail(cause) };
            }
          return outcome;
        });
        research.operations.set(job.id, { controller, work });
        this.#pending.add(work);
        void work.then(
          () => {
            this.#pending.delete(work);
            this.#finish(research);
          },
          (cause) => {
            this.#pending.delete(work);
            this.#error(research, job, cause);
            research.operations.delete(job.id);
            this.#finish(research);
          },
        );
        return {
          cancel: (reason) => {
            if (previous === undefined)
              void this.#cancel(research, "job-cancelled").catch(() => {});
            else
              controller.abort(
                new DOMException(
                  reason ?? "Research step cancelled.",
                  "AbortError",
                ),
              );
          },
          done: previous === undefined ? research.completion.promise : work,
        };
      },
    });
    return { jobId: id };
  }

  #error(research: ResearchExecution, job: JobHandle, cause: unknown): void {
    research.errors.push(cause);
    research.terminal = true;
    research.deliverySettled = false;
    for (const operation of research.operations.values())
      operation.controller.abort(cause);
    const detail = failureDetail(cause);
    try {
      appendResearchRecord(job, {
        type: "research/message",
        text: detail,
      });
    } catch (error) {
      research.errors.push(error);
    }
    try {
      this.ports.onError(research.owner, { jobId: job.id }, detail);
    } catch (error) {
      research.errors.push(error);
      research.deliverySettled = true;
    }
  }

  #publish(research: ResearchExecution, supplied?: RunView): void {
    if (research.finished) return;
    const view =
      supplied ??
      (research.runId === undefined
        ? undefined
        : this.ports.runs.view({ runId: research.runId }));
    research.outcome = researchJobOutcome(research.preparationStatus, view);
    if (
      view?.status === "completed" ||
      view?.status === "cancelled" ||
      (view === undefined && research.preparationStatus !== "preparing")
    )
      research.terminal = true;
    const progress = researchJobView({
      preparationStatus: research.preparationStatus,
      view,
      collection: research.collection,
      identity: research.identity,
      operationIds: [...research.operations.keys()].filter(
        (id) => id !== research.job.id,
      ),
    });
    const encoded = serializeJson(progress);
    if (research.publishedProgress !== encoded) {
      research.publishedProgress = encoded;
      research.job.updateProgress(progress.text);
      appendResearchRecord(research.job, {
        type: "research/progress",
        progress,
      });
    }
    this.#finish(research);
  }

  #finish(research: ResearchExecution): void {
    if (
      !research.terminal ||
      research.finished ||
      research.cancelling ||
      research.operations.size > 0
    )
      return;
    try {
      if (research.runId !== undefined) this.ports.releaseRun(research.runId);
    } catch (cause) {
      this.#error(research, research.job, cause);
    }
    research.finished = true;
    const outcome =
      research.errors.length > 0
        ? {
            status: "failed" as const,
            detail: research.errors.map(failureDetail).join("\n"),
          }
        : (research.outcome ??
          researchJobOutcome(research.preparationStatus, undefined));
    if (
      this.ports.isClosing() ||
      !this.ports.isOwnerLive(research.owner) ||
      (research.owner.status === "idle" &&
        (outcome.status === "killed" || research.deliverySettled))
    ) {
      try {
        this.#release(research);
      } catch (cause) {
        this.#error(research, research.job, cause);
        outcome.status = "failed";
        outcome.detail = research.errors.map(failureDetail).join("\n");
      }
    }
    research.completion.resolve(outcome);
  }

  #requestCancel(
    research: ResearchExecution,
    requestId: string,
  ): Promise<void> {
    const work = this.#cancel(research, requestId);
    try {
      this.ports.jobs.kill(
        research.job.id,
        research.owner.id,
        "Research cancelled.",
      );
    } catch (cause) {
      this.#error(research, research.job, cause);
      return work.then(() => {
        throw cause;
      });
    }
    return work;
  }

  #cancel(research: ResearchExecution, requestId: string): Promise<void> {
    if (research.cancellation !== undefined) return research.cancellation;
    if (research.finished) {
      if (research.runId === undefined) return Promise.resolve();
      research.cancellation = this.ports
        .cancelRun(
          { runId: research.runId, identity: research.owner.id },
          requestId,
        )
        .then(() => {});
      void research.cancellation.catch(() => {});
      return research.cancellation;
    }
    research.cancelling = true;
    let control: Promise<unknown>;
    try {
      control =
        research.runId === undefined
          ? Promise.resolve()
          : this.ports.cancelRun(
              { runId: research.runId, identity: research.owner.id },
              requestId,
            );
    } catch (cause) {
      control = Promise.reject(cause);
    }
    for (const operation of research.operations.values())
      operation.controller.abort(
        new DOMException("Research cancelled.", "AbortError"),
      );
    research.cancellation = (async () => {
      const [controlled] = await Promise.allSettled([
        control,
        ...[...research.operations.values()].map(({ work }) => work),
      ]);
      if (controlled!.status === "rejected")
        this.#error(research, research.job, controlled!.reason);
      research.preparationStatus = "cancelled";
      if (research.errors.length === 0)
        try {
          this.#publish(research);
        } catch (cause) {
          this.#error(research, research.job, cause);
        }
      research.terminal = true;
      research.cancelling = false;
      this.#finish(research);
      if (research.errors.length > 1)
        throw new AggregateError(
          research.errors,
          "Could not cancel research.",
          { cause: research.errors[0] },
        );
      if (research.errors.length === 1) throw research.errors[0];
    })();
    void research.cancellation.catch(() => {});
    return research.cancellation;
  }

  #release(research: ResearchExecution): void {
    if (research.resourcesReleased) return;
    research.resourcesReleased = true;
    research.release();
  }
  idleOwner(owner: Agent): void {
    for (const research of this.#executions) {
      if (research.owner !== owner || !research.terminal) continue;
      research.deliverySettled = true;
      if (research.finished) this.#release(research);
    }
  }
  async disposeOwner(owner: Agent): Promise<void> {
    const owned = [...this.#executions].filter(
      (research) => research.owner === owner,
    );
    const results = await Promise.allSettled(
      owned
        .filter((research) => !research.finished)
        .map((research) => this.#requestCancel(research, "owner-disposed")),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const research of owned) {
      try {
        this.#release(research);
      } catch (cause) {
        failures.push(cause);
      }
      this.#executions.delete(research);
      if (
        research.runId !== undefined &&
        this.#runs.get(research.runId) === research
      )
        this.#runs.delete(research.runId);
      for (const [id, execution] of this.#jobs)
        if (execution === research) this.#jobs.delete(id);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not release research Jobs.", {
        cause: failures[0],
      });
  }
  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
