import assert from "node:assert/strict";
import console from "node:console";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const { NumberService } = await import(core);
const samples = 11;
const runId = "reference-benchmark";
const cutoff = "2024-01-02T21:00:00.000Z";
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
  cutoff,
};
const envelope = {
  dataset: "market",
  data: {
    currency: "USD",
    adjustment: "split_adjusted",
    bars: [
      {
        date: scope.date,
        asOf: cutoff,
        availableAt: cutoff,
        sessionComplete: true,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
      },
    ],
  },
  source: {
    provider: "synthetic",
    url: "https://example.com/benchmark",
    adapterVersion: "1",
    normalizationVersion: "1",
  },
  asOf: cutoff,
  availableAt: cutoff,
  cutoff,
  retrievedAt: cutoff,
  ageMs: 0,
  stale: false,
  historicalKnowledge: "verified",
  gaps: [],
  candidateClaims: [],
};
const adoptedClaims = [100, 120].map((value, index) => ({
  id: `price-${index}`,
  kind: "estimated",
  value,
  unit: "USD/share",
  method: "Synthetic price scenario",
  assumptions: ["Synthetic input"],
  evidence: [],
}));
function content(claims, inputRefs = []) {
  return {
    kind: "analysis",
    title: "Synthetic reference benchmark",
    body: "Benchmark",
    inputRefs,
    claims,
    payload: {},
  };
}

function fixture(registrations) {
  const tasks = Array.from({ length: 22 }, (_, index) => ({
    taskId: `task-${index}`,
    status: "running",
    outputRefs: [],
    attempts: [
      {
        number: 1,
        status: "running",
        inputRefs: [],
        outputRefs: [],
        instructionVersion: 1,
        sessionId: null,
        startedAt: cutoff,
        endedAt: null,
        failure: null,
      },
    ],
  }));
  const taskId = tasks.at(-1).taskId;
  const evidence = Array.from({ length: registrations }, (_, index) => ({
    evidenceId: `evidence-${index}`,
    taskId,
    attempt: 1,
    callId: `data-${index}`,
  }));
  const artifacts = Array.from({ length: registrations }, (_, index) => ({
    ref: { runId, artifactId: `artifact-${index}`, revision: 1 },
    kind: "analysis",
    taskId,
    attempt: 1,
    createdAt: cutoff,
  }));
  let evidenceReads = 0;
  let artifactReads = 0;
  const reader = {
    numberContext: () => ({ runId, scope, tasks, evidence, artifacts }),
    readEvidence: (ref) => {
      evidenceReads++;
      return {
        ...evidence.at(-1),
        evidenceId: ref.evidenceId,
        runId,
        request: {
          dataset: "market",
          provider: "synthetic",
          securityId: scope.security.id,
          parameters: {},
        },
        envelope,
        recordedAt: cutoff,
      };
    },
    readArtifact: (ref) => {
      artifactReads++;
      return {
        ref,
        taskId,
        attempt: 1,
        producerSessionId: null,
        createdAt: cutoff,
        schemaVersion: 1,
        content: content(adoptedClaims),
      };
    },
  };
  return {
    numbers: new NumberService(reader),
    source: {
      runId,
      evidenceId: evidence.at(-1).evidenceId,
      selector: "/data/bars/0/close",
    },
    artifact: artifacts.at(-1).ref,
    reset: () => {
      evidenceReads = 0;
      artifactReads = 0;
    },
    reads: () => ({ evidenceReads, artifactReads }),
  };
}

const measurements = [];
for (const registrations of [1, 100, 1000]) {
  const c = fixture(registrations);
  for (const count of [1, 1000]) {
    for (const kind of ["observed", "adopted"]) {
      const claims = Array.from({ length: count }, (_, index) =>
        kind === "observed"
          ? {
              id: `observed-${index}`,
              kind: "observed",
              value: 100,
              unit: "USD/share",
              source: c.source,
            }
          : {
              id: `gain-${index}`,
              kind: "calculated",
              value: 0.2,
              unit: "ratio",
              operation: "simple_return",
              inputs: adoptedClaims.map(({ id }) => ({
                kind: "artifact",
                artifact: c.artifact,
                claimId: id,
              })),
            },
      );
      const target = {
        kind: "pending",
        contentId: "benchmark",
        content: content(claims, kind === "adopted" ? [c.artifact] : []),
      };
      const run = () => {
        c.reset();
        const start = performance.now();
        const result = c.numbers.checkNumbers(
          { runId, identity: "bench" },
          target,
        );
        const elapsed = performance.now() - start;
        assert.equal(result.passed, true);
        assert.equal(result.claims.length, count);
        assert.deepEqual(c.reads(), {
          evidenceReads: kind === "observed" ? 1 : 0,
          artifactReads: kind === "adopted" ? 1 : 0,
        });
        return elapsed;
      };
      run();
      run();
      const times = Array.from({ length: samples }, run).sort((a, b) => a - b);
      measurements.push({
        registrationsPerKind: registrations,
        tasks: 22,
        claims: count,
        kind,
        medianMs: times[Math.floor(samples / 2)],
        p95Ms: times[Math.ceil(samples * 0.95) - 1],
        ...c.reads(),
      });
    }
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      samples,
      source:
        "synthetic in-memory reader; last registered reference reused; measures numeric gate and lookup scaling, excludes storage, sources and models",
      measurements,
    },
    null,
    2,
  ),
);
