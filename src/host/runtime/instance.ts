import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { SqliteCache } from "../../cache/index.js";
import { ResearchError } from "../../contracts/errors.js";
import type { MemoryAccess } from "../../contracts/memory-service.js";
import type { QuerySnapshot, QueryPolicy } from "../../contracts/query.js";
import type { QueryAccess } from "../../contracts/query-service.js";
import type { OpenRunInput, RunView } from "../../contracts/runs.js";
import type { RunAccess } from "../../contracts/run-access.js";
import type { DataEnvelope } from "../../contracts/data.js";
import type { CollectionAccess } from "../../contracts/collection.js";
import type { ResearchData } from "../../contracts/research.js";
import type { HttpClient } from "../../data/http.js";
import type { ArtifactService } from "../../services/artifact-submission/index.js";
import type { DecisionService } from "../../services/decisions.js";
import type { MemoryService } from "../../services/memory/index.js";
import type { NumberService } from "../../services/numbers/index.js";
import type { QueryService } from "../../services/query/index.js";
import type { TaskQueryService } from "../../services/task-query.js";
import type { CollectionService } from "../../services/collection/index.js";
import { selectQuerySnapshot } from "../../services/query-snapshot.js";
import type { DataRoot } from "../../storage/data-root.js";
import { createValuationTools } from "../../tools/valuation.js";
import { createControlTools } from "../../tools/control.js";
import { createDataTools, type DataToolServices } from "../../tools/data.js";
import { createReadTools } from "../../tools/read.js";
import { createDataHealthTool } from "../../tools/data-health.js";
import { createRecallTool } from "../../tools/recall.js";
import { createWriteTools } from "../../tools/write.js";
import { createServiceTaskTools } from "../../tools/service-tasks.js";
import {
  createValuationOperations,
  type ValuationOperations,
} from "../valuation-operations.js";
import {
  createDispatchOperations,
  createServiceTaskOperations,
  createCollectionTaskOperations,
  type ResearchOperations,
} from "../research-operations.js";
import type { SessionBindings, ResearchBinding } from "../bindings.js";
import {
  createRunReadOperations,
  type RunReadOperations,
} from "../run-reading.js";
import {
  createReportSubmission,
  type SubmitReport,
} from "../report-submission.js";
import type { DispatchBridge } from "../dispatch/index.js";
import type { ResearchSessions } from "../sessions/index.js";
import {
  createScheduledResearchExecutor,
  type ScheduledResearchExecutor,
} from "../scheduled-operations.js";
import { searchPublic, approvePublicSearch } from "../public-search.js";
import { settle, throwFailures, type Dispose } from "./lifecycle.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    stockResearch: ResearchRuntime;
  }
}

export interface ResearchRuntime {
  isBusy(): boolean;
  readonly runs: RunAccess;
  readonly reads: RunReadOperations;
  readonly queries: QueryAccess;
  readonly collection: CollectionAccess;
  readonly memory: MemoryAccess;
  readonly dispatch: DispatchBridge;
  readonly operations: ResearchOperations;
  readonly executeScheduled: ScheduledResearchExecutor;
  readonly policy: QueryPolicy;
  readonly submitReport: SubmitReport;
  readonly valuations: ValuationOperations;
  bindCoordinator(agent: Agent): () => void;
  authorizeCoordinatorRun(agent: Agent, runId: string): void;
  searchPublic(
    query: string,
    exec: ToolRunContext,
    parent?: Agent,
  ): Promise<DataEnvelope<ResearchData>>;
  approvePublicSearch(
    query: string,
    exec: ToolRunContext,
    used: number,
    parent?: Agent,
  ): Promise<boolean>;
  openRun(
    agent: Agent | undefined,
    input: OpenRunInput,
    requestId: string,
  ): RunView;
  createTools(
    policy: QueryPolicy,
    snapshots?: readonly QuerySnapshot[],
  ): ToolDefinition[];
  createCoordinatorTools(operations: ResearchOperations): ToolDefinition[];
  createDataHealthTool(): ToolDefinition;
  createRecallTool(): ToolDefinition;
  createAgent(
    options: CreateAgentOptions,
    binding: ResearchBinding,
    tools: readonly ToolDefinition[],
  ): Promise<AgentHandle>;
  close(): Promise<void>;
}

interface PendingAgent {
  controller: AbortController;
  drained: Promise<unknown[]>;
}
interface Components {
  root: Pick<DataRoot, "close">;
  cache: Pick<SqliteCache, "close">;
  http: Pick<HttpClient, "close">;
  runs: RunAccess;
  queries: QueryService;
  taskQueries: TaskQueryService;
  collection: CollectionService;
  memory: MemoryService;
  numbers: Pick<NumberService, "checkNumbers">;
  artifacts: Pick<ArtifactService, "submitArtifact">;
  decisions: Pick<DecisionService, "decide">;
  sessions: Pick<ResearchSessions, "setup" | "close" | "dispose">;
  bindings: SessionBindings;
  dispatch: DispatchBridge;
}

export class Runtime implements ResearchRuntime {
  readonly runs: RunAccess;
  readonly reads: RunReadOperations;
  readonly queries: QueryService;
  readonly collection: CollectionService;
  readonly memory: MemoryService;
  readonly dispatch: DispatchBridge;
  readonly operations: ResearchOperations;
  readonly executeScheduled: ScheduledResearchExecutor;
  readonly submitReport: SubmitReport;
  readonly valuations: ValuationOperations;
  readonly #pending = new Set<PendingAgent>();
  readonly #agents = new Map<Agent, AgentHandle>();
  #closing: Promise<void> | undefined;
  withdraw!: Dispose;

  constructor(
    private readonly ctx: Context,
    private readonly components: Components,
    private readonly capturedPolicy: QueryPolicy,
    private readonly publicSearchEnabled: boolean,
  ) {
    this.runs = components.runs;
    this.reads = createRunReadOperations(this.runs, components.bindings);
    this.queries = components.queries;
    this.collection = components.collection;
    this.memory = components.memory;
    this.dispatch = components.dispatch;
    this.operations = {
      ...createDispatchOperations(components.dispatch),
      ...createServiceTaskOperations(components.dispatch, components.decisions),
      ...createCollectionTaskOperations(components.dispatch),
    };
    this.executeScheduled = createScheduledResearchExecutor(
      this.dispatch,
      components.bindings,
      this.operations,
    );
    this.submitReport = createReportSubmission(
      components.artifacts,
      components.bindings,
    );
    this.valuations = createValuationOperations(this.runs, components.bindings);
  }

  get policy(): QueryPolicy {
    return structuredClone(this.capturedPolicy);
  }

  isBusy(): boolean {
    return this.#pending.size > 0 || this.#agents.size > 0;
  }

  searchPublic(
    query: string,
    exec: ToolRunContext,
    parent?: Agent,
  ): Promise<DataEnvelope<ResearchData>> {
    this.#requireOpen();
    if (!this.publicSearchEnabled)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "The dsh-web source is disabled.",
      );
    return searchPublic(
      this.ctx,
      this.runs,
      this.components.bindings,
      query,
      exec,
      parent,
    );
  }

  approvePublicSearch(
    query: string,
    exec: ToolRunContext,
    used: number,
    parent?: Agent,
  ): Promise<boolean> {
    this.#requireOpen();
    const { binding } = this.components.bindings.require(exec.agent);
    return approvePublicSearch(
      this.ctx,
      query,
      exec,
      used,
      parent,
      binding.kind === "task" && binding.background === true,
    );
  }

  bindCoordinator(agent: Agent): () => void {
    this.#requireOpen();
    if (this.ctx.agents.get(agent.id) !== agent)
      throw new ResearchError(
        "ACCESS_DENIED",
        "A live host Agent is required.",
      );
    return this.components.bindings.bind(agent, {
      kind: "coordinator",
      runIds: [],
    });
  }

  authorizeCoordinatorRun(agent: Agent, runId: string): void {
    this.#requireOpen();
    const { binding } = this.components.bindings.require(agent);
    if (binding.kind !== "coordinator")
      throw new ResearchError(
        "ACCESS_DENIED",
        "A coordinator binding is required.",
      );
    this.runs.view({ runId });
    if (!binding.runIds.includes(runId))
      binding.runIds = [...binding.runIds, runId];
  }

  openRun(
    agent: Agent | undefined,
    input: OpenRunInput,
    requestId: string,
  ): RunView {
    this.#requireOpen();
    const { agent: caller, binding } = this.components.bindings.require(agent);
    if (binding.kind !== "coordinator")
      throw new ResearchError(
        "ACCESS_DENIED",
        "Opening a run requires a coordinator binding.",
      );
    const { runId } = this.runs.open(caller.id, input, requestId);
    if (!binding.runIds.includes(runId))
      binding.runIds = [...binding.runIds, runId];
    return this.runs.view({ runId });
  }

  createTools(
    policy: QueryPolicy,
    snapshots: readonly QuerySnapshot[] = [],
  ): ToolDefinition[] {
    const { bindings, numbers, artifacts } = this.components;
    const taskQueries: DataToolServices["taskQueries"] = {
      replayForTask: (...args) =>
        this.components.taskQueries.replayForTask(...args),
      queryForTask: (operation, request, callId, signal) =>
        this.components.taskQueries.queryForTask(
          operation,
          request,
          callId,
          signal,
          selectQuerySnapshot(request, snapshots),
        ),
    };
    return [
      ...createReadTools(
        {
          runs: this.runs,
          reads: this.reads,
          queries: this.queries,
          memory: this.memory,
          numbers,
        },
        bindings,
      ),
      ...createValuationTools(this.runs, bindings),
      ...createDataTools(
        { runs: this.runs, queries: this.queries, taskQueries },
        bindings,
        policy,
      ),
      ...createWriteTools({ artifacts, memory: this.memory }, bindings, policy),
      ...this.createCoordinatorTools(this.operations),
    ];
  }

  createDataHealthTool(): ToolDefinition {
    return createDataHealthTool(
      this.queries,
      this.runs,
      this.components.bindings,
      false,
    );
  }

  createRecallTool(): ToolDefinition {
    return createRecallTool(this.memory, this.components.bindings, false);
  }

  createCoordinatorTools(operations: ResearchOperations): ToolDefinition[] {
    const { bindings } = this.components;
    return [
      ...createServiceTaskTools(operations, bindings),
      ...createControlTools(operations, bindings),
    ];
  }

  createAgent(
    options: CreateAgentOptions,
    binding: ResearchBinding,
    tools: readonly ToolDefinition[],
  ): Promise<AgentHandle> {
    this.#requireOpen();
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const researchSetup = this.components.sessions.setup(binding, tools);
    let setupWork: Promise<unknown> | undefined;
    const setup: AgentSetup = (agentCtx, agent) => {
      const work = Promise.resolve().then(async () => {
        const prepared = await options.setup?.(agentCtx, agent);
        // AgentLoop can reject its race with cancellation before setup settles.
        signal.throwIfAborted();
        const research = await researchSetup(agentCtx, agent);
        return {
          commit() {
            prepared?.commit();
            research?.commit();
          },
        };
      });
      setupWork = work;
      return work;
    };
    const cleanupFailures: unknown[] = [];
    let resolveDrain!: (failures: unknown[]) => void;
    const pending: PendingAgent = {
      controller,
      drained: new Promise<unknown[]>((resolve) => {
        resolveDrain = resolve;
      }),
    };
    this.#pending.add(pending);
    // Record ownership before entering the SDK, including synchronous callbacks.
    return Promise.resolve().then(async () => {
      try {
        const handle = await this.ctx.agents.create({
          ...options,
          signal,
          setup,
        });
        if (this.#closing !== undefined || signal.aborted) {
          const failures = await settle([() => handle.dispose()]);
          cleanupFailures.push(...failures);
          throwFailures(failures);
          signal.throwIfAborted();
          this.#requireOpen();
        }
        let disposal: Promise<void> | undefined;
        const owned: AgentHandle = {
          agent: handle.agent,
          dispose: () =>
            (disposal ??= Promise.resolve()
              .then(() => handle.dispose())
              .finally(() => {
                this.#agents.delete(handle.agent);
              })),
        };
        this.#agents.set(handle.agent, owned);
        return owned;
      } catch (cause) {
        // Keep late setup side effects inside this runtime's lifetime.
        const [setup] = await Promise.allSettled(
          setupWork === undefined ? [] : [setupWork],
        );
        if (
          setup?.status === "rejected" &&
          setup.reason !== cause &&
          setup.reason !== signal.reason
        )
          throw new AggregateError(
            [cause, setup.reason],
            "Agent creation and setup failed.",
            { cause },
          );
        throw cause;
      } finally {
        this.#pending.delete(pending);
        resolveDrain(cleanupFailures);
      }
    });
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    const pending = [...this.#pending];
    this.#closing = Promise.resolve().then(() => this.#close(pending));
    this.components.sessions.close();
    for (const pending of this.#pending) pending.controller.abort();
    return this.#closing;
  }

  async #close(pending: readonly PendingAgent[]): Promise<void> {
    const { sessions, http, cache, root } = this.components;
    const failures = await settle([this.withdraw]);
    failures.push(
      ...(await settle([
        () => this.dispatch.close(),
        () => this.queries.close(),
        () => this.components.taskQueries.close(),
        () => this.collection.close(),
        () => this.memory.close(),
        () => http.close(),
        ...[...this.#agents.values()].map((handle) => () => handle.dispose()),
        ...pending.map((pending) => async () => {
          failures.push(...(await pending.drained));
        }),
      ])),
    );
    failures.push(...(await settle([sessions.dispose])));
    failures.push(...(await settle([() => cache.close()])));
    failures.push(...(await settle([() => root.close()])));
    throwFailures(failures);
  }

  #requireOpen(): void {
    if (this.#closing !== undefined)
      throw new ResearchError("ACCESS_DENIED", "Research runtime is closed.");
  }
}
