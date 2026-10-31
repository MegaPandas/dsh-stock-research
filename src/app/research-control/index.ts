import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ResearchScope } from "../../contracts/data.js";
import type { RunReader, RunLifecycle } from "../../contracts/run-access.js";
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
import type { BoundCaller, ResearchCaller } from "../../host/bindings.js";
import type { ResearchOperations } from "../../host/research-operations.js";
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
} from "../research-actions.js";

interface ResearchCoordinator {
  bind(owner: Agent): () => void;
  register(
    owner: Agent,
    actions: ResearchActions,
    operations: ResearchOperations,
    retain: (release: () => void) => void,
  ): void;
}

export interface ResearchApplicationPorts extends Omit<
  ResearchExecutionPorts,
  "runs" | "isClosing"
> {
  runs: Pick<
    RunReader,
    "view" | "readDefinition" | "inputCatalog" | "readInput"
  > &
    Pick<RunLifecycle, "open" | "reviewStage" | "resume">;
  operations: ResearchOperations;
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
  ): Promise<RedoTaskResult>;
}

/** The receiving host Agent drives every transition through individual tools. */
export class ResearchApplication implements ResearchActions {
  readonly #coordinators = new Map<Agent, (() => void)[]>();
  readonly #executions: ResearchExecutions;
  readonly #starts = new Map<
    string,
    { owner: Agent; request: string; work: Promise<ResearchContext> }
  >();
  readonly #disposing = new Map<Agent, Promise<void>>();
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
      this.coordinator.register(agent, this, this.#operations(), (release) =>
        releases.push(release),
      );
    }
    return agent;
  }

  #operations(): ResearchOperations {
    const wrap =
      <Input extends { runId: string }, Result>(
        label: string,
        action: (
          request: Input,
          caller: BoundCaller,
          signal: AbortSignal,
        ) => Promise<Result>,
      ) =>
      (
        request: Input,
        caller: BoundCaller,
        signal: AbortSignal,
      ): Promise<Result> => {
        this.#owned(caller.agent, request.runId);
        return this.#executions.perform(
          request.runId,
          label,
          signal,
          (active) => action(request, caller, active),
        );
      };
    const operations = this.ports.operations;
    return {
      dispatchTask: wrap("stock_dispatch_task", operations.dispatchTask),
      dispatchStage: wrap("stock_dispatch_stage", operations.dispatchStage),
      followupTask: wrap("stock_followup_task", operations.followupTask),
      makeDigest: wrap("stock_make_digest", operations.makeDigest),
      decide: wrap("stock_decide", operations.decide),
      redoTask: wrap("stock_redo_task", operations.redoTask),
    };
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

  start(
    input: StartResearchRequest,
    caller: ResearchCaller,
  ): Promise<ResearchContext> {
    const owner = this.#main(caller.agent);
    const { scope, mode, requestId } = input;
    const { security, date } = scope;
    const request = serializeJson({ security: security.id, date, mode });
    const key = JSON.stringify([owner.id, requestId]);
    const existing = this.#starts.get(key);
    if (existing !== undefined) {
      if (existing.request !== request)
        throw new ResearchError(
          "REQUEST_CONFLICT",
          "The research request ID was already used for another selection.",
        );
      return existing.work;
    }
    const settings = this.ports.settings();
    const models = captureResearchModels(owner, this.model ?? settings?.model);
    const publicSearchLimit =
      settings?.publicSearchLimit ?? PUBLIC_SEARCH_LIMITS.maxSearches;
    const policy = this.ports.policy();
    const sources = this.ports.describeSources(scope);
    const work = this.#executions.start(
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
        return this.#context(view.runId);
      },
    );
    this.#starts.set(key, { owner, request, work });
    return work;
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
    const collection = readCollection(runs, runId);
    return {
      runId,
      view: runs.view({ runId }),
      tasks: runs
        .readDefinition(runId)
        .tasks.map(({ id, executor }) => ({ id, executor })),
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
      );
    this.ports.authorizeRun(owner, runId);
    const existing = this.#executions.ownerOf(runId);
    if (existing !== undefined && existing !== owner)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Continue this live research in its owning chat.",
      );
    if (existing === undefined)
      await this.#executions.start(
        owner,
        { label: researchContinueLabel(runId) },
        signal,
        async (_signal, attach) => {
          attach(runId);
          return this.#context(runId);
        },
      );
    else this.#executions.publish(runId);
    return { kind: "continuation", context: this.#context(runId) };
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
        for (const [key, start] of this.#starts)
          if (start.owner === owner) this.#starts.delete(key);
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
