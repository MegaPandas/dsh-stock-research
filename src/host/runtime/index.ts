import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SqliteCache } from "../../cache/index.js";
import { ResearchError } from "../../contracts/errors.js";
import type { MemoryState } from "../../contracts/memory-service.js";
import type { RunState } from "../../contracts/runs.js";
import type { ResearchConfig } from "../../contracts/settings.js";
import { HttpClient } from "../../data/http.js";
import { createCollectionTaskFactory } from "../../data/collection-tasks.js";
import { MemoryStore } from "../../memory/store.js";
import { RunStore } from "../../runs/store.js";
import { ArtifactService } from "../../services/artifact-submission/index.js";
import { DecisionService } from "../../services/decisions.js";
import { DigestService } from "../../services/digest/index.js";
import { generateHandoffDigest } from "../../services/digest/handoff.js";
import { MemoryService } from "../../services/memory/index.js";
import { NumberService } from "../../services/numbers/index.js";
import { QueryService } from "../../services/query/index.js";
import { TaskQueryService } from "../../services/task-query.js";
import { CollectionService } from "../../services/collection/index.js";
import { CollectionRunService } from "../../services/collection-run/index.js";
import { CollectionSnapshotStore } from "../../storage/collection-snapshots.js";
import { createRunService } from "../../services/run/index.js";
import { DataRoot } from "../../storage/data-root.js";
import { SessionBindings } from "../bindings.js";
import { Config } from "../config.js";
import { DispatchBridge, type PrepareRole } from "../dispatch/index.js";
import { ResearchSessions } from "../sessions/index.js";
import { createSources } from "../sources.js";
import { Runtime } from "./instance.js";
import { releaseReverse, type Dispose } from "./lifecycle.js";

export type { ResearchRuntime } from "./instance.js";

/** The application supplies role composition; deployment config supplies resources. */
export function createResearchPlugin(prepareRole: PrepareRole) {
  return {
    name: "stock-research",
    Config,
    inject: ["tools", "agents", "subagents"],
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
        const runs = createRunService(new RunStore<RunState>(root), now);
        const queries = new QueryService(sources, cache, config.cache.ttl);
        acquired.push(() => queries.close());
        const taskQueries = new TaskQueryService(queries, runs);
        acquired.push(() => taskQueries.close());
        const collection = new CollectionService(
          createCollectionTaskFactory(
            http,
            (scope, request, signal) => queries.query(scope, request, signal),
            {
              secCiks: config.policy.secCiks,
              ...(config.xueqiuCookie === undefined
                ? {}
                : { xueqiuCookie: config.xueqiuCookie }),
            },
          ),
          cache,
          {
            enabledSources: config.enabledSources,
            freshness: config.policy.freshness,
            ttl: config.cache.ttl,
            requireDailyMarket: true,
          },
          new CollectionSnapshotStore(root),
        );
        acquired.push(() => collection.close());
        const collections = new CollectionRunService(runs, collection);
        acquired.push(() => collections.close());
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
          generateHandoffDigest,
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
          collections,
        );
        const runtime = new Runtime(
          ctx,
          {
            root,
            cache,
            http,
            runs,
            queries,
            taskQueries,
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
