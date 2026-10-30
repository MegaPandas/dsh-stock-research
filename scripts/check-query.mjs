import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  CollectionService,
  DataRoot,
  HttpClient,
  QueryService,
  TaskQueryService,
  RunService,
  RunStore,
  SqliteCache,
  YahooMarketAdapter,
  parseLocalDate,
} from "@megapandas/dsh-stock-research/core";

if (process.argv.length !== 3) {
  console.error("Usage: node scripts/check-query.mjs <YYYY-MM-DD>");
  process.exit(2);
}
const date = parseLocalDate(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), "dsh-real-query-"));
const scope = {
  security: {
    id: "US:NVDA",
    market: "US",
    symbol: "NVDA",
    exchange: "NASDAQ",
    currency: "USD",
    timeZone: "America/New_York",
  },
  date,
  cutoff: new Date(
    Math.min(Date.now(), Date.parse(`${date}T23:59:59.999Z`)),
  ).toISOString(),
};
const ttl = { market: 3_600_000, fundamentals: 0, macro: 0, research: 0 };
let cache;
let http;
let queries;
let collector;
let taskQueries;
let root;
let stage = "initialize";
let sourceCalls = 0;
async function closeServices() {
  const results = await Promise.allSettled([
    taskQueries?.close(),
    collector?.close(),
    queries?.close(),
    http?.close(),
  ]);
  const errors = results
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);
  if (errors.length > 0)
    throw new AggregateError(errors, "Query acceptance cleanup failed");
}
try {
  cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 10,
  });
  http = new HttpClient({
    timeoutMs: 20_000,
    maxConcurrency: 1,
    minIntervalMs: 2000,
  });
  const yahoo = new YahooMarketAdapter(http);
  let sourceParameters;
  queries = new QueryService(
    {
      yahoo: {
        capability: yahoo.capability,
        query(input, signal) {
          sourceCalls++;
          const { scope: suppliedScope, ...parameters } = input;
          assert.deepEqual(suppliedScope, scope);
          sourceParameters = globalThis.structuredClone(parameters);
          return yahoo.query(input, signal);
        },
      },
    },
    cache,
    ttl,
  );
  collector = new CollectionService(http, cache, queries, {
    enabledSources: ["yahoo"],
    freshness: { market: 7 * 86_400_000, fundamentals: 0, macro: 0 },
    secCiks: {},
    ttl,
    requireDailyMarket: true,
  });
  stage = "ordinary-collection";
  const collected = await collector.collect(scope);
  const packet = collected.packets.find(({ id }) => id === "market.daily");
  assert.ok(packet, "The required daily market table must be collected");
  assert.ok(packet.envelope.data.rows.length > 0);
  assert.equal(existsSync(join(directory, "runs")), false);
  const request = {
    dataset: "market",
    provider: "yahoo",
    parameters: sourceParameters,
  };
  const envelope = await queries.query(scope, request);
  const latest = envelope.data.bars.at(-1);
  const row = packet.envelope.data.rows.at(-1);
  assert.equal(latest.date, row.date);
  assert.equal(latest.close, row.values.close);
  assert.ok(Number.isFinite(latest.close));
  assert.equal(sourceCalls, 1);
  stage = "task-query-cache";
  root = new DataRoot(directory);
  const store = new RunStore(root);
  const runs = new RunService(store, () => new Date().toISOString());
  const manifest = createRequire(import.meta.url)(
    "@megapandas/dsh-stock-research/package.json",
  );
  const versions = {
    plugin: manifest.version,
    mode: "real-query-acceptance",
    prompts: {},
    skills: {},
    adapters: { "market/yahoo": yahoo.capability.adapterVersion },
    normalization: { "market/yahoo": yahoo.capability.normalizationVersion },
  };
  const { runId } = runs.open(
    "acceptance",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: ["live", "captured"].map((id) => ({
          id,
          executor: { kind: "role", role: "analyst", specialty: "market" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        })),
      },
      versions,
      inputs: [],
    },
    "open",
  );
  const liveOperation = {
    ...runs.claim({ runId, identity: "acceptance" }, "live", "claim-live"),
    identity: "acceptance-task",
    sessionId: null,
  };
  taskQueries = new TaskQueryService(queries, runs);
  const live = await taskQueries.queryForTask(liveOperation, request, "market");
  assert.deepEqual(live.envelope.data, envelope.data);
  assert.equal(store.read(runId).evidence.length, 1);
  await queries.close();
  cache.close();

  stage = "captured-evidence";
  const operation = {
    ...runs.claim(
      { runId, identity: "acceptance" },
      "captured",
      "claim-captured",
    ),
    identity: "acceptance-task",
    sessionId: null,
  };
  const captured = await taskQueries.queryForTask(
    operation,
    request,
    "market",
    undefined,
    { scope, request, envelope },
  );
  assert.deepEqual(
    await taskQueries.queryForTask(operation, request, "market"),
    captured,
  );
  assert.equal(store.read(runId).evidence.length, 2);
  stage = "offline-replay";
  const derived = runs.open(
    "acceptance",
    { replay: { runId }, versions },
    "replay",
  );
  const replayOperation = {
    ...runs.claim({ ...derived, identity: "acceptance" }, "captured", "claim"),
    identity: "acceptance-task",
    sessionId: null,
  };
  const replayed = await taskQueries.queryForTask(
    replayOperation,
    request,
    "market",
  );
  assert.deepEqual(replayed.envelope.data, envelope.data);
  assert.deepEqual(
    runs.readEvidence(replayed.sourceRef).replayedFrom,
    captured.sourceRef,
  );
  assert.equal(store.read(derived.runId).evidence.length, 1);
  assert.equal(sourceCalls, 1);
  console.log(
    JSON.stringify(
      {
        case: "real Yahoo collection, task cache reuse, captured evidence and offline replay",
        date,
        sourceCalls,
        rows: packet.envelope.data.rows.length,
        latest: { date: latest.date, close: latest.close },
        ordinaryWithoutRunDirectory: true,
        liveTaskEvidence: 1,
        capturedEvidence: store
          .read(runId)
          .evidence.filter(({ taskId }) => taskId === "captured").length,
        replayEvidence: store.read(derived.runId).evidence.length,
        snapshotAndReplayWithClosedQueryAndCache: true,
      },
      null,
      2,
    ),
  );
} catch (cause) {
  console.error(
    JSON.stringify({
      case: "real query",
      stage,
      code: cause?.code ?? cause?.name ?? "UNKNOWN",
      assertion: cause?.code === "ERR_ASSERTION" ? cause.message : undefined,
      sourceCalls,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await closeServices();
  } finally {
    try {
      cache?.close();
    } finally {
      try {
        root?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
