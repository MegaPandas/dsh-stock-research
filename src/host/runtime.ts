import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { createValuationTools } from "../tools/valuation.js";
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-fs";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { SqliteCache } from "../cache/index.js";
import { ResearchError } from "../contracts/errors.js";
import type { MemoryState } from "../contracts/memory-service.js";
import type { QuerySnapshot } from "../contracts/query.js";
import type {
  OpenRunInput,
  RunState,
  RunView,
  TaskOperation,
} from "../contracts/runs.js";
import { HttpClient } from "../data/http.js";
import { MemoryStore } from "../memory/store.js";
import { RunStore } from "../runs/store.js";
import { ArtifactService } from "../services/artifacts.js";
import { DecisionService } from "../services/decisions.js";
import { DigestService } from "../services/digests.js";
import { MemoryService } from "../services/memory.js";
import { NumberService } from "../services/numbers.js";
import { QueryService } from "../services/query.js";
import { CollectionService } from "../services/collection.js";
import { CollectionSnapshotStore } from "../storage/collection-snapshots.js";
import { selectQuerySnapshot } from "../services/query-snapshot.js";
import { RunService } from "../services/runs.js";
import { DataRoot } from "../storage/data-root.js";
import { createControlTools } from "../tools/control.js";
import { createDataTools, type DataToolServices } from "../tools/data.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import { createReadTools } from "../tools/read.js";
import { createWriteTools } from "../tools/write.js";
import { SessionBindings, type ResearchBinding } from "./bindings.js";
import { Config, type ResearchConfig } from "./config.js";
import { HostDigestModel } from "./digest-model.js";
import { DispatchBridge, type PrepareRole } from "./dispatch.js";
import { ResearchSessions } from "./sessions.js";
import { createSources } from "./sources.js";
import { taskDraftFile, DraftFile } from "./draft-file.js";
import { searchPublic, approvePublicSearch } from "./public-search.js";
import type { DataEnvelope } from "../contracts/data.js";
import type { ResearchData } from "../contracts/research.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    stockResearch: ResearchRuntime;
  }
}

export interface ResearchRuntime {
  isBusy(): boolean;
  readonly runs: RunService;
  readonly queries: QueryService;
  readonly collection: CollectionService;
  readonly memory: MemoryService;
  readonly dispatch: DispatchBridge;
  readonly tools: readonly ToolDefinition[];
  readonly policy: QueryToolPolicy;
  bindCoordinator(agent: Agent): () => void;
  authorizeCoordinatorRun(agent: Agent, runId: string): void;
  createDraftFile(
    operation: Pick<TaskOperation, "runId" | "taskId">,
  ): DraftFile;
  createReviewDraftFile(reviewId: string): DraftFile;
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
    policy: QueryToolPolicy,
    snapshots?: readonly QuerySnapshot[],
  ): ToolDefinition[];
  createAgent(
    options: CreateAgentOptions,
    binding: ResearchBinding,
    tools: readonly ToolDefinition[],
  ): Promise<AgentHandle>;
  close(): Promise<void>;
}

type Dispose = () => void | Promise<void>;
interface PendingAgent {
  controller: AbortController;
  drained: Promise<unknown[]>;
}
interface Components {
  root: DataRoot;
  cache: SqliteCache;
  http: HttpClient;
  runs: RunService;
  queries: QueryService;
  collection: CollectionService;
  memory: MemoryService;
  numbers: NumberService;
  artifacts: ArtifactService;
  decisions: DecisionService;
  sessions: ResearchSessions;
  bindings: SessionBindings;
  dispatch: DispatchBridge;
}

async function settle(actions: readonly Dispose[]): Promise<unknown[]> {
  return (
    await Promise.allSettled(
      actions.map((action) => Promise.resolve().then(action)),
    )
  ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
function throwFailures(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Research runtime cleanup failed.", {
      cause: failures[0],
    });
}
async function releaseReverse(actions: readonly Dispose[]): Promise<void> {
  const failures: unknown[] = [];
  for (const action of [...actions].reverse())
    failures.push(...(await settle([action])));
  throwFailures(failures);
}

class Runtime implements ResearchRuntime {
  readonly runs: RunService;
  readonly queries: QueryService;
  readonly collection: CollectionService;
  readonly memory: MemoryService;
  readonly dispatch: DispatchBridge;
  readonly tools: readonly ToolDefinition[];
  readonly #pending = new Set<PendingAgent>();
  readonly #agents = new Map<Agent, AgentHandle>();
  #closing: Promise<void> | undefined;
  withdraw!: Dispose;

  constructor(
    private readonly ctx: Context,
    private readonly components: Components,
    private readonly capturedPolicy: QueryToolPolicy,
    private readonly publicSearchEnabled: boolean,
  ) {
    this.runs = components.runs;
    this.queries = components.queries;
    this.collection = components.collection;
    this.memory = components.memory;
    this.dispatch = components.dispatch;
    this.tools = this.createTools(capturedPolicy);
  }

  get policy(): QueryToolPolicy {
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
    return approvePublicSearch(this.ctx, query, exec, used, parent);
  }

  createDraftFile(
    operation: Pick<TaskOperation, "runId" | "taskId">,
  ): DraftFile {
    this.#requireOpen();
    return taskDraftFile(
      this.ctx.fs,
      join(this.components.root.path, "drafts"),
      operation,
    );
  }

  createReviewDraftFile(reviewId: string): DraftFile {
    this.#requireOpen();
    return new DraftFile(
      this.ctx.fs,
      join(
        this.components.root.path,
        "reviews",
        `review-${encodeURIComponent(reviewId)}.md`,
      ),
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
    policy: QueryToolPolicy,
    snapshots: readonly QuerySnapshot[] = [],
  ): ToolDefinition[] {
    const { bindings, numbers, artifacts, decisions } = this.components;
    const queries: DataToolServices["queries"] = {
      query: (...args) => this.queries.query(...args),
      replayForTask: (...args) => this.queries.replayForTask(...args),
      queryForTask: (operation, request, callId, signal) =>
        this.queries.queryForTask(
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
          queries: this.queries,
          memory: this.memory,
          numbers,
        },
        bindings,
      ),
      ...createValuationTools(this.runs, bindings),
      ...createDataTools({ runs: this.runs, queries }, bindings, policy),
      ...createWriteTools(
        { artifacts, decisions, memory: this.memory, digests: this.dispatch },
        bindings,
        policy,
      ),
      ...createControlTools(this.dispatch, bindings),
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

/** The application supplies role composition; deployment config supplies resources. */
export function createResearchPlugin(prepareRole: PrepareRole) {
  return {
    name: "stock-research",
    Config,
    inject: ["tools", "agents", "subagents", "fs"],
    async apply(ctx: Context, config: ResearchConfig): Promise<void> {
      config = structuredClone(config);
      const spawn = ctx.subagents.getProvider("spawn");
      if (
        spawn === undefined ||
        spawn.inheritsParentContext ||
        spawn.prepareContinuable === undefined
      )
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Research requires a local spawn provider with independent context.",
        );
      await ctx.effect(async function* () {
        const acquired: Dispose[] = [];
        let ready = false;
        yield () => (ready ? undefined : releaseReverse(acquired));
        const root = new DataRoot(config.dataRoot);
        acquired.push(() => root.close());
        const cache = new SqliteCache({
          path: join(root.path, "cache.sqlite"),
          maxEntries: config.cache.maxEntries,
        });
        acquired.push(() => cache.close());
        const http = new HttpClient(config.http);
        acquired.push(() => http.close());
        const sources = createSources(ctx, http, config);
        const now = () => new Date().toISOString();
        const runs = new RunService(new RunStore<RunState>(root), now);
        const queries = new QueryService(
          sources,
          cache,
          runs,
          config.cache.ttl,
        );
        acquired.push(() => queries.close());
        const collection = new CollectionService(
          http,
          cache,
          queries,
          {
            enabledSources: config.enabledSources,
            ...(config.xueqiuCookie === undefined
              ? {}
              : { xueqiuCookie: config.xueqiuCookie }),
            freshness: config.policy.freshness,
            secCiks: config.policy.secCiks,
            ttl: config.cache.ttl,
            requireDailyMarket: true,
          },
          new CollectionSnapshotStore(root),
        );
        acquired.push(() => collection.close());
        const memory = new MemoryService(
          new MemoryStore<MemoryState>(root, () => ({
            stateVersion: 1,
            receipts: [],
          })),
          runs,
          (scope, request, signal) => queries.query(scope, request, signal),
          now,
        );
        acquired.push(() => memory.close());
        const numbers = new NumberService(runs);
        const artifacts = new ArtifactService(runs, numbers);
        const digests = new DigestService(
          runs,
          artifacts,
          new HostDigestModel(ctx, config.digestModel).generate,
        );
        acquired.push(() => digests.close());
        const decisions = new DecisionService(runs, now);
        const bindings = new SessionBindings();
        const sessions = new ResearchSessions(ctx, bindings);
        acquired.push(sessions.dispose);
        yield sessions.dispose;
        const dispatch = new DispatchBridge(
          ctx,
          runs,
          sessions,
          prepareRole,
          digests,
        );
        const runtime = new Runtime(
          ctx,
          {
            root,
            cache,
            http,
            runs,
            queries,
            collection,
            memory,
            numbers,
            artifacts,
            decisions,
            bindings,
            sessions,
            dispatch,
          },
          config.policy,
          config.enabledSources.includes("dsh-web"),
        );
        const withdraw = ctx.provide("stockResearch", runtime);
        runtime.withdraw = withdraw;
        acquired.push(withdraw);
        yield withdraw;
        // Adopt the exact Cordis effects so they cannot unload beside active work.
        yield () => runtime.close();
        ready = true;
      });
    },
  };
}
