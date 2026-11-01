import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ResearchScope } from "../../contracts/data.js";
import type { ArtifactPayloads } from "../../contracts/artifact-payloads.js";
import type {
  RunReader,
  RunLifecycle,
  RunChanges,
} from "../../contracts/run-access.js";
import type { QueryPolicy } from "../../contracts/query.js";
import type { SourceDescription } from "../../contracts/sources.js";
import type {
  AttemptTarget,
  OpenRunInput,
  RecoverAttemptsResult,
  RedoTaskResult,
  RunOperation,
  RunView,
} from "../../contracts/runs.js";
import type { ResearchCaller } from "../../host/bindings.js";
import type {
  ResearchOperations,
  ResearchFollowupRequest,
  ResearchCancelRequest,
  ResearchRedoRequest,
} from "../../host/research-operations.js";
import type { ScheduledResearchExecutor } from "../../host/scheduled-operations.js";
import { RunScheduler } from "../../services/scheduler/index.js";
import { ResearchError } from "../../contracts/errors.js";
import { serializeJson } from "../../json/serialize.js";
import { readCollection } from "../collection-input.js";
import { savedCoordinator } from "../coordinator-input.js";
import { openResearch, type OpenResearchPorts } from "./open.js";
import {
  captureResearchModels,
  RESEARCH_MODELS_INPUT,
} from "../research-models.js";
import type { ModelConfig } from "../../contracts/settings.js";
import {
  ResearchExecutions,
  type ResearchExecutionPorts,
} from "../research-execution/index.js";
import { createReplayInput } from "../replay-input.js";
import {
  researchStartLabel,
  researchContinueLabel,
} from "../research-execution/labels.js";
import { PUBLIC_SEARCH_LIMITS } from "../public-research.js";
import type {
  ResearchActions,
  StartResearchRequest,
  ReviewResearchRequest,
  ResearchContext,
  ResearchControl,
  ResearchControlResult,
  ResearchHandle,
  ResearchObservation,
  ResearchNotice,
} from "../research-actions.js";

interface ResearchCoordinator {
  bind(owner: Agent): () => void;
  register(
    owner: Agent,
    actions: ResearchActions,
    retain: (release: () => void) => void,
  ): void;
}

export interface ResearchApplicationPorts extends Omit<
  ResearchExecutionPorts,
  "runs" | "isClosing" | "onError"
> {
  runs: Pick<
    RunReader,
    "view" | "readDefinition" | "inputCatalog" | "readInput" | "readArtifact"
  > &
    Pick<RunLifecycle, "open" | "reviewStage" | "resume"> &
    RunChanges;
  operations: Pick<ResearchOperations, "followupTask" | "cancelTask">;
  executeScheduled: ScheduledResearchExecutor;
  notify(owner: Agent, notice: ResearchNotice): void;
  collection: OpenResearchPorts["collection"];
  settings():
    | {
        readonly model: ModelConfig | undefined;
        readonly publicSearchLimit: number;
      }
    | undefined;
  policy(): QueryPolicy;
  describeSources(scope: ResearchScope): readonly SourceDescription[];
  openRun(owner: Agent, input: OpenRunInput, requestId: string): RunView;
  authorizeRun(owner: Agent, runId: string): void;
  recoverInterrupted(
    operation: RunOperation,
    targets: readonly AttemptTarget[],
    requestId: string,
  ): RecoverAttemptsResult;
  redoRun(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    reason: string | null,
    instruction: string | null,
  ): Promise<RedoTaskResult>;
}

/** Owns application decisions; background scheduling owns mechanical dispatch. */
export class ResearchApplication implements ResearchActions {
  readonly #coordinators = new Map<Agent, (() => void)[]>();
  readonly #executions: ResearchExecutions;
  readonly #starts = new WeakMap<
    Agent,
    Map<string, { request: string; handle: ResearchHandle }>
  >();
  readonly #disposing = new Map<Agent, Promise<void>>();
  readonly #revisions = new WeakMap<
    Agent,
    Map<string, { request: string; handle: ResearchHandle }>
  >();
  #closed = false;
  constructor(
    private readonly ports: ResearchApplicationPorts,
    private readonly model: ModelConfig | undefined,
    private readonly coordinator: ResearchCoordinator,
  ) {
    this.#executions = new ResearchExecutions({
      jobs: ports.jobs,
      runs: ports.runs,
      cancelRun: ports.cancelRun,
      releaseRun: ports.releaseRun,
      holdActivity: ports.holdActivity,
      isOwnerLive: ports.isOwnerLive,
      isClosing: () => this.#closed,
      onError: (owner, handle, detail) => {
        if (this.#closed || !this.ports.isOwnerLive(owner)) return;
        this.ports.notify(owner, {
          kind: "failed",
          ...handle,
          detail,
        });
      },
    });
  }

  #main(agent: Agent | undefined): Agent {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Stock research is closed.");
    if (agent === undefined || !this.ports.isOwnerLive(agent))
      throw new ResearchError(
        "ACCESS_DENIED",
        "A live host Agent is required.",
      );
    if (!this.#coordinators.has(agent)) {
      const releases = [this.coordinator.bind(agent)];
      this.#coordinators.set(agent, releases);
      this.coordinator.register(agent, this, (release) =>
        releases.push(release),
      );
    }
    return agent;
  }

  #owned(agent: Agent | undefined, runId: string): Agent {
    this.#main(agent);
    const owner = this.#executions.ownerOf(runId);
    if (owner === undefined || owner !== agent)
      throw new ResearchError(
        "ACCESS_DENIED",
        "This research is not attached to the current chat. Use an explicit resume request.",
      );
    return owner;
  }

  start(input: StartResearchRequest, caller: ResearchCaller): ResearchHandle {
    const owner = this.#main(caller.agent);
    const { scope, mode, requestId } = input;
    const { security, date } = scope;
    const request = serializeJson({ security: security.id, date, mode });
    const starts = this.#starts.get(owner);
    const existing = starts?.get(requestId);
    if (existing !== undefined) {
      if (existing.request !== request)
        throw new ResearchError(
          "REQUEST_CONFLICT",
          "The research request ID was already used for another selection.",
        );
      return existing.handle;
    }
    const settings = this.ports.settings();
    const models = captureResearchModels(owner, this.model ?? settings?.model);
    const publicSearchLimit =
      settings?.publicSearchLimit ?? PUBLIC_SEARCH_LIMITS.maxSearches;
    const policy = this.ports.policy();
    const sources = this.ports.describeSources(scope);
    const handle = this.#executions.start(
      owner,
      {
        label: researchStartLabel(scope, mode),
        identity: { symbol: security.symbol, date, mode },
      },
      caller.signal,
      async (signal, attach, onProgress) => {
        const view = await openResearch(
          {
            collection: this.ports.collection,
            now: () => new Date(),
            openRun: (input, id) => {
              const opened = this.ports.openRun(owner, input, id);
              // Attach before awaiting so cancellation can reach the published run.
              attach(opened.runId);
              return opened;
            },
          },
          {
            scope,
            mode,
            policy,
            sources,
            publicSearchLimit,
            requestId,
            modelInput: {
              name: RESEARCH_MODELS_INPUT,
              content: JSON.parse(serializeJson(models)),
            },
          },
          signal,
          onProgress,
        );
        await this.#schedule(owner, view.runId, signal);
      },
    );
    const saved = starts ?? new Map();
    saved.set(requestId, { request, handle });
    this.#starts.set(owner, saved);
    return handle;
  }

  observe(jobId: string, caller: ResearchCaller): ResearchObservation {
    const owner = this.#main(caller.agent);
    caller.signal.throwIfAborted();
    return this.#executions.read(jobId, owner);
  }

  async cancel(
    jobId: string,
    caller: ResearchCaller,
    requestId: string,
  ): Promise<ResearchObservation> {
    const owner = this.#main(caller.agent);
    caller.signal.throwIfAborted();
    await this.#executions.cancelJob(jobId, owner, requestId);
    return this.#executions.read(jobId, owner);
  }

  revise(
    input: ResearchFollowupRequest,
    caller: ResearchCaller,
  ): ResearchHandle {
    const owner = this.#owned(caller.agent, input.runId);
    caller.signal.throwIfAborted();
    const key = JSON.stringify([input.runId, input.requestId]);
    const request = serializeJson(input);
    const revisions = this.#revisions.get(owner);
    const existing = revisions?.get(key);
    if (existing !== undefined) {
      if (existing.request !== request)
        throw new ResearchError(
          "REQUEST_CONFLICT",
          "The revision request ID was already used with different input.",
        );
      return existing.handle;
    }
    const handle = this.#executions.launch(
      input.runId,
      `修订 ${input.taskId}`,
      caller.signal,
      (signal) =>
        this.ports.operations.followupTask(
          input,
          {
            agent: owner,
            binding: { kind: "coordinator", runIds: [input.runId] },
          },
          signal,
        ),
    );
    const saved = revisions ?? new Map();
    saved.set(key, { request, handle });
    this.#revisions.set(owner, saved);
    return handle;
  }

  redoTask(
    input: ResearchRedoRequest,
    caller: ResearchCaller,
  ): Promise<ResearchControlResult> {
    this.#owned(caller.agent, input.runId);
    return this.control(
      {
        kind: "redo",
        runId: input.runId,
        taskId: input.taskId,
        reason: input.reason,
        instruction: input.instruction ?? null,
      },
      caller,
      input.requestId,
    );
  }

  cancelTask(input: ResearchCancelRequest, caller: ResearchCaller) {
    const owner = this.#owned(caller.agent, input.runId);
    return this.ports.operations.cancelTask(
      input,
      { agent: owner, binding: { kind: "coordinator", runIds: [input.runId] } },
      caller.signal,
    );
  }

  async #schedule(
    owner: Agent,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const notices = new Set<string>();
    let firstScan = true;
    const scheduler = new RunScheduler(runId, {
      runs: this.ports.runs,
      execute: (execution, active) =>
        this.ports.executeScheduled(owner, runId, execution, active),
      onChange: (view) => {
        const initial = firstScan;
        firstScan = false;
        if (!this.#closed && this.ports.isOwnerLive(owner)) {
          const notify = (
            key: string,
            notice: Omit<ResearchNotice, "jobId" | "runId">,
          ) => {
            if (notices.has(key)) return;
            notices.add(key);
            this.ports.notify(owner, {
              ...notice,
              runId,
              ...this.#executions.handleFor(runId),
            });
          };
          for (const stage of view.stages ?? [])
            if (
              (view.status === "active" || view.status === "blocked") &&
              stage.readyForReview &&
              !stage.accepted
            )
              notify(JSON.stringify(["review", stage.id, stage.refs]), {
                kind: "review",
                stageId: stage.id,
              });
          const failed = view.tasks.filter(({ status }) => status === "failed");
          // An explicit blocked resume already returns the unresolved reasons.
          if ((view.status === "blocked" && !initial) || failed.length > 0)
            notify(
              JSON.stringify([
                "blocked",
                view.blockReasons,
                failed.map(({ taskId, attempt }) => ({ taskId, attempt })),
              ]),
              { kind: "blocked" },
            );
          if (view.status === "completed")
            notify("completed", { kind: "completed" });
        }
        this.#executions.publish(runId, view);
      },
    });
    const abort = () => {
      void scheduler.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await scheduler.start();
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
      await scheduler.close();
    }
  }

  #continue(owner: Agent, runId: string, signal: AbortSignal): ResearchHandle {
    if (this.#executions.running(runId))
      return this.#executions.handleFor(runId);
    const released = this.#executions.settled(runId);
    return this.#executions.start(
      owner,
      { label: researchContinueLabel(runId), runId },
      signal,
      async (active) => {
        await released;
        await this.#schedule(owner, runId, active);
      },
    );
  }

  review(input: ReviewResearchRequest, caller: ResearchCaller): RunView {
    const { runId, requestId, stageId, verdict, feedback, refs } = input;
    const owner = this.#owned(caller.agent, runId);
    this.ports.runs.reviewStage(
      { runId, identity: owner.id },
      { stageId, verdict, feedback, refs },
      requestId,
    );
    this.#executions.publish(runId);
    return this.ports.runs.view({ runId });
  }

  #context(runId: string): ResearchContext {
    const runs = this.ports.runs;
    const view = runs.view({ runId });
    const definition = runs.readDefinition(runId);
    const dataTasks = new Set(
      definition.tasks
        .filter(
          ({ executor }) =>
            executor.kind === "service" && executor.service === "collection",
        )
        .map(({ id }) => id),
    );
    const snapshots = view.tasks
      .filter(
        ({ taskId, status }) => dataTasks.has(taskId) && status === "succeeded",
      )
      .flatMap(({ outputRefs }) =>
        outputRefs.map(
          (ref) =>
            (
              runs.readArtifact(ref).content
                .payload as ArtifactPayloads["collection"]
            ).snapshot,
        ),
      );
    const collection = readCollection(runs, runId, snapshots);
    return {
      runId,
      view,
      tasks: definition.tasks.map(({ id, executor }) => ({ id, executor })),
      ...(collection === null
        ? {}
        : {
            collection: {
              cutoff: collection.scope.cutoff,
              tables: collection.packets.map(({ id, envelope }) => ({
                id,
                title: envelope.data.title,
                rows: envelope.data.rows.length,
              })),
              failures: collection.failures,
            },
          }),
    };
  }

  idleOwner(owner: Agent): void {
    this.#executions.idleOwner(owner);
  }

  async control(
    input: ResearchControl,
    caller: ResearchCaller,
    requestId: string,
  ): Promise<ResearchControlResult> {
    const owner = this.#main(caller.agent);
    const signal = caller.signal;
    signal.throwIfAborted();
    const runs = this.ports.runs;
    const operation = { runId: input.runId, identity: owner.id };
    if (input.kind === "status")
      return {
        kind: "status",
        view: runs.view(operation),
      };
    if (input.kind === "cancel") {
      if (this.#executions.ownerOf(input.runId) === undefined)
        await this.ports.cancelRun(operation, requestId);
      else await this.#executions.cancel(input.runId, requestId);
      return {
        kind: "status",
        view: runs.view(operation),
      };
    }
    if (input.kind === "recover") {
      this.ports.recoverInterrupted(operation, input.attempts, requestId);
      return {
        kind: "status",
        view: runs.view(operation),
      };
    }
    const attached = this.#executions.ownerOf(input.runId);
    if (input.kind !== "replay" && attached !== undefined && attached !== owner)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Continue this live research in its owning chat.",
      );
    if (input.kind === "resume" || input.kind === "redo")
      savedCoordinator(runs, input.runId);
    let runId = input.runId;
    if (input.kind === "replay")
      runId = runs.open(
        owner.id,
        createReplayInput(runs, input.runId),
        requestId,
      ).runId;
    else if (input.kind === "resume")
      runs.resume(operation, input.input, requestId);
    else
      await this.ports.redoRun(
        operation,
        input.taskId,
        requestId,
        input.reason,
        input.instruction,
      );
    this.ports.authorizeRun(owner, runId);
    const existing = this.#executions.ownerOf(runId);
    if (existing !== undefined && existing !== owner)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Continue this live research in its owning chat.",
      );
    const handle = this.#continue(owner, runId, signal);
    this.#executions.publish(runId);
    return { kind: "continuation", context: this.#context(runId), handle };
  }

  disposeOwner(owner: Agent): Promise<void> {
    const existing = this.#disposing.get(owner);
    if (existing !== undefined) return existing;
    const work = Promise.resolve()
      .then(async () => {
        const failures: unknown[] = [];
        try {
          await this.#executions.disposeOwner(owner);
        } catch (cause) {
          failures.push(cause);
        }
        for (const release of this.#coordinators.get(owner)?.reverse() ?? []) {
          try {
            release();
          } catch (cause) {
            failures.push(cause);
          }
        }
        this.#coordinators.delete(owner);
        this.#starts.delete(owner);
        this.#revisions.delete(owner);
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Could not release research owner.",
            { cause: failures[0] },
          );
      })
      .finally(() => this.#disposing.delete(owner));
    this.#disposing.set(owner, work);
    return work;
  }
  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#coordinators.keys()].map((owner) => this.disposeOwner(owner)),
    );
    await this.#executions.drain();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Could not release research executions.",
        { cause: failures[0] },
      );
  }
}
