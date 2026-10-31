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
import type { CancelRunResult, RunOperation } from "../../contracts/runs.js";
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

const JOB_WAIT_MS = 60_000;

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
  finishedAt?: number;
  runId?: string;
  preparationStatus: ResearchPreparationStatus;
  release: () => void;
  resourcesReleased: boolean;
  operations: Map<
    JobId,
    { controller: AbortController; work: Promise<unknown> }
  >;
}

export interface ResearchExecutionPorts {
  jobs: Pick<JobRegistry, "start" | "wait">;
  runs: Pick<RunReader, "view">;
  cancelRun(
    operation: RunOperation,
    requestId: string,
  ): Promise<CancelRunResult>;
  releaseRun(runId: string): void;
  holdActivity(): () => void;
  isOwnerLive(owner: Agent): boolean;
  isClosing(): boolean;
}

function researchCompletion(): ResearchExecution["completion"] {
  let resolve!: (outcome: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Owns research Jobs and their execution resources; callers own canonical mutations. */
export class ResearchExecutions {
  readonly #executions = new Set<ResearchExecution>();
  readonly #runs = new Map<string, ResearchExecution>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(private readonly ports: ResearchExecutionPorts) {}

  ownerOf(runId: string): Agent | undefined {
    return this.#runs.get(runId)?.owner;
  }

  start<T>(
    owner: Agent,
    selection: { label: string; identity?: ResearchIdentity },
    signal: AbortSignal,
    action: (
      signal: AbortSignal,
      attach: (runId: string) => void,
      onProgress: (progress: CollectionProgress) => void,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#perform(
      owner,
      undefined,
      selection.label,
      signal,
      (research, job, active) => {
        if (selection.identity !== undefined)
          research.identity = selection.identity;
        return action(
          active,
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
    );
  }

  perform<T>(
    runId: string,
    label: string,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const research = this.#runs.get(runId)!;
    return research.finishedAt !== undefined
      ? action(signal)
      : this.#perform(
          research.owner,
          research,
          label,
          signal,
          (_research, _job, active) => action(active),
        );
  }

  publish(runId: string): void {
    this.#publish(this.#runs.get(runId)!);
  }

  cancel(runId: string, requestId: string): Promise<void> {
    return this.#cancel(this.#runs.get(runId)!, requestId);
  }

  async #perform<T>(
    owner: Agent,
    previous: ResearchExecution | undefined,
    label: string,
    callerSignal: AbortSignal,
    action: (
      research: ResearchExecution,
      job: JobHandle,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    callerSignal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    let work!: Promise<T>;
    let research!: ResearchExecution;
    const id = this.ports.jobs.start({
      kind: previous === undefined ? RESEARCH_JOB_KIND : RESEARCH_STEP_JOB_KIND,
      label,
      owner: owner.id,
      run: (job) => {
        research = previous ?? {
          owner,
          job,
          completion: researchCompletion(),
          preparationStatus: "preparing",
          release: this.ports.holdActivity(),
          resourcesReleased: false,
          operations: new Map(),
        };
        this.#executions.add(research);
        job.updateProgress(
          previous === undefined ? "准备采集数据" : "执行研究任务",
        );
        const release = this.ports.holdActivity();
        work = Promise.resolve()
          .then(async () => {
            try {
              const pending = action(research, job, signal);
              this.#publish(research);
              return await pending;
            } catch (cause) {
              if (research.runId === undefined) {
                research.preparationStatus = signal.aborted
                  ? "cancelled"
                  : "failed";
                this.#publish(research);
              }
              appendResearchRecord(job, {
                type: "research/message",
                text: failureDetail(cause),
              });
              throw cause;
            } finally {
              research.operations.delete(job.id);
              this.#publish(research);
            }
          })
          .finally(release);
        research.operations.set(job.id, { controller, work });
        this.#pending.add(work);
        void work.then(
          () => this.#pending.delete(work),
          () => this.#pending.delete(work),
        );
        return {
          cancel: (reason) => {
            controller.abort(
              new DOMException(
                reason ?? "Research operation cancelled.",
                "AbortError",
              ),
            );
            if (previous === undefined && research.finishedAt === undefined)
              void this.#cancel(research, "job-cancelled").catch((cause) =>
                research.completion.resolve({
                  status: "failed",
                  detail: failureDetail(cause),
                }),
              );
          },
          done:
            previous === undefined
              ? research.completion.promise
              : work.then(
                  (result) => ({
                    status: "completed" as const,
                    result: serializeJson(result),
                  }),
                  (cause) => ({
                    status: signal.aborted
                      ? ("killed" as const)
                      : ("failed" as const),
                    detail: failureDetail(cause),
                  }),
                ),
        };
      },
    });
    if (previous === undefined) return work;
    // The Agent tool, rather than the browser command request, owns this wait.
    let view = await this.ports.jobs.wait(id, JOB_WAIT_MS, owner.id);
    while (view.status === "running" || view.status === "stopping")
      view = await this.ports.jobs.wait(id, JOB_WAIT_MS, owner.id);
    return work;
  }

  #finish(research: ResearchExecution): void {
    if (research.finishedAt !== undefined) return;
    research.finishedAt = Date.now();
    if (research.runId !== undefined) this.ports.releaseRun(research.runId);
    const view =
      research.runId === undefined
        ? undefined
        : this.ports.runs.view({ runId: research.runId });
    const outcome = researchJobOutcome(research.preparationStatus, view);
    void Promise.allSettled(
      [...research.operations.values()].map(({ work }) => work),
    ).then(() => research.completion.resolve(outcome));
    if (
      this.ports.isClosing() ||
      research.owner.status === "idle" ||
      !this.ports.isOwnerLive(research.owner)
    )
      this.#release(research);
  }

  #release(research: ResearchExecution): void {
    if (research.resourcesReleased) return;
    research.resourcesReleased = true;
    research.release();
  }

  idleOwner(owner: Agent): void {
    for (const research of this.#executions)
      if (research.owner === owner && research.finishedAt !== undefined)
        this.#release(research);
  }

  #publish(research: ResearchExecution): void {
    const view =
      research.runId === undefined
        ? undefined
        : this.ports.runs.view({ runId: research.runId });
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
    if (
      view?.status === "completed" ||
      view?.status === "cancelled" ||
      (view === undefined && research.preparationStatus !== "preparing")
    )
      this.#finish(research);
  }

  async #cancel(research: ResearchExecution, requestId: string): Promise<void> {
    for (const operation of research.operations.values())
      operation.controller.abort(
        new DOMException("Research cancelled.", "AbortError"),
      );
    const results = await Promise.allSettled([
      ...(research.runId === undefined
        ? []
        : [
            this.ports.cancelRun(
              { runId: research.runId, identity: research.owner.id },
              requestId,
            ),
          ]),
      ...[...research.operations.values()].map(({ work }) =>
        work.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]);
    research.preparationStatus = "cancelled";
    this.#publish(research);
    this.#finish(research);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not cancel research.", {
        cause: failures[0],
      });
  }

  async disposeOwner(owner: Agent): Promise<void> {
    const stopped = await Promise.allSettled(
      [...this.#executions]
        .filter(
          (research) =>
            research.owner === owner && research.finishedAt === undefined,
        )
        .map((research) => this.#cancel(research, "owner-disposed")),
    );
    for (const research of this.#executions) {
      if (research.owner !== owner) continue;
      this.#release(research);
      this.#executions.delete(research);
      if (research.runId !== undefined) this.#runs.delete(research.runId);
    }
    const failures = stopped.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not release research Jobs.", {
        cause: failures[0],
      });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}
