import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  DataRoot,
  HostResearchAdapter,
  QueryService,
  RunService,
  RunStore,
  SqliteCache,
} from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-query-bench-"));
const scope = {
  security: {
    id: "US:NVDA",
    market: "US",
    symbol: "NVDA",
    exchange: "NASDAQ",
    currency: "USD",
    timeZone: "America/New_York",
  },
  date: "2024-01-02",
  cutoff: "2024-01-02T21:00:00.000Z",
};
const request = {
  dataset: "research",
  provider: "dsh-web",
  parameters: { query: "NVDA earnings", maxResults: 1 },
};
const gate = Promise.withResolvers();
const started = Promise.withResolvers();
const count = 100;
let sourceCalls = 0;
const research = new HostResearchAdapter(async (input) => {
  sourceCalls++;
  started.resolve();
  assert.deepEqual(input, request.parameters);
  await gate.promise;
  return {
    sources: [
      {
        url: "https://example.com/benchmark",
        title: "Synthetic query benchmark",
        snippet: "x".repeat(1024),
      },
    ],
    truncated: false,
  };
});
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
let root;
let cache;
let queries;
try {
  root = new DataRoot(directory);
  cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 8,
  });
  const store = new RunStore(root);
  const runs = new RunService(store, () => "2024-01-03T00:00:00.000Z");
  const { runId } = runs.open(
    "benchmark",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          {
            id: "analysis",
            executor: { kind: "role", role: "analyst", specialty: "benchmark" },
            dependsOn: [],
            inputTasks: [],
            outputKinds: ["analysis"],
            dataRequirements: [],
            instructionVersion: 1,
          },
        ],
      },
      versions: {
        plugin: "0.1.0-dev.1",
        mode: "benchmark",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "open",
  );
  const claimed = runs.claim(
    { runId, identity: "benchmark" },
    "analysis",
    "claim",
  );
  const operation = {
    runId,
    identity: "benchmark-task",
    taskId: "analysis",
    attempt: claimed.attempt,
    sessionId: null,
  };
  queries = new QueryService({ research }, cache, runs, {
    market: 60_000,
    fundamentals: 60_000,
    macro: 60_000,
    research: 60_000,
  });
  const begin = performance.now();
  const ordinary = Array.from({ length: count }, () =>
    queries.query(scope, request),
  );
  const tasks = Array.from({ length: count }, () =>
    queries.queryForTask(operation, request, "data"),
  );
  await started.promise;
  gate.resolve();
  const [frames, registered] = await Promise.all([
    Promise.all(ordinary),
    Promise.all(tasks),
  ]);
  const concurrentMs = performance.now() - begin;
  assert.equal(sourceCalls, 1);
  assert.equal(store.read(runId).evidence.length, 1);
  for (const result of registered) {
    assert.deepEqual(result.sourceRef, registered[0].sourceRef);
    assert.equal(result.envelope.retrievedAt, frames[0].retrievedAt);
    assert.deepEqual(result.envelope.gaps, frames[0].gaps);
    assert.deepEqual(result.envelope.candidateClaims, []);
  }
  const hits = [];
  const saved = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await queries.query(scope, request);
    hits.push(performance.now() - start);
  }
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await queries.queryForTask(operation, request, "data");
    saved.push(performance.now() - start);
  }
  assert.equal(sourceCalls, 1);
  const profile = queries
    .health(scope)
    .sources.find(({ provider }) => provider === "dsh-web");
  assert.equal(profile.cacheHits, count);
  assert.equal(profile.sourceCalls, 1);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        source: "synthetic host search; no external requests",
        snippetBytes: 1024,
        envelopeBytes: Buffer.byteLength(JSON.stringify(frames[0])),
        concurrentOrdinaryQueries: count,
        concurrentSameTaskCallQueries: count,
        concurrentMs,
        sourceCalls,
        registeredEvidence: store.read(runId).evidence.length,
        cacheHit: stats(hits),
        savedTaskCall: stats(saved),
      },
      null,
      2,
    ),
  );
} finally {
  gate.resolve();
  try {
    await queries?.close();
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
