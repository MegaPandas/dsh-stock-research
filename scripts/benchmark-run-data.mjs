import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DataRoot, RunService, RunStore } from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-run-data-bench-"));
const timestamp = "2024-01-03T00:00:00.000Z";
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
const query = { dataset: "market", provider: "benchmark", parameters: {} };
const data = {
  envelope: {
    dataset: "market",
    data: { price: 100, payload: "x".repeat(1024) },
    source: {
      provider: "benchmark",
      url: "https://example.com/benchmark",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: scope.cutoff,
    availableAt: null,
    retrievedAt: timestamp,
    cutoff: scope.cutoff,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data",
        detail: "Synthetic benchmark",
      },
    ],
  },
  candidates: [
    {
      candidateId: "price",
      label: "Price",
      value: 100,
      unit: "USD/share",
      asOf: scope.cutoff,
      selector: "/data/price",
    },
  ],
};
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
let root;
try {
  root = new DataRoot(directory);
  const service = new RunService(new RunStore(root), () => timestamp);
  const { runId } = service.open(
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
  const claimed = service.claim(
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
  const writes = [];
  const replays = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    service.recordEvidence(operation, query, data, `data-${i}`);
    writes.push(performance.now() - start);
  }
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const ref = service.evidenceForCall(
      operation,
      query,
      `data-${i}`,
    ).sourceRef;
    service.readEvidence(ref);
    replays.push(performance.now() - start);
  }
  const memories = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    service.recordMemoryInput(
      operation,
      { scope: { securityId: scope.security.id }, parameters: { limit: 3 } },
      [],
      `memory-${i}`,
    );
    memories.push(performance.now() - start);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        evidenceCalls: 100,
        candidateClaimsPerEvidence: 1,
        payloadBytes: 1024,
        memoryCalls: 20,
        memoryEntriesPerCall: 0,
        evidenceCommit: stats(writes),
        savedCallRead: stats(replays),
        emptyMemoryCommit: stats(memories),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    root?.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
