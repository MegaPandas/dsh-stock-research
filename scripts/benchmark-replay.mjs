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
  RunService,
  RunStore,
} from "@megapandas/dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-replay-bench-"));
const versions = {
  plugin: "0.1.0-dev.1",
  mode: "benchmark",
  prompts: {},
  skills: {},
  adapters: {},
  normalization: {},
};
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
const data = {
  envelope: {
    dataset: "market",
    data: { payload: "x".repeat(1024) },
    source: {
      provider: "benchmark",
      url: "https://example.com/benchmark",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: scope.cutoff,
    availableAt: null,
    retrievedAt: "2024-01-03T00:00:00.000Z",
    cutoff: scope.cutoff,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data",
        detail: "Synthetic replay benchmark.",
      },
    ],
  },
  candidates: [],
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
      versions,
      inputs: [{ name: "prompt", content: "x".repeat(1024) }],
    },
    "source",
  );
  const claimed = runs.claim(
    { runId, identity: "benchmark" },
    "analysis",
    "claim",
  );
  const operation = { ...claimed, identity: "benchmark-task", sessionId: null };
  for (let i = 0; i < 100; i++)
    runs.recordEvidence(
      operation,
      { dataset: "market", provider: "benchmark", parameters: { index: i } },
      data,
      `data-${i}`,
    );
  for (let i = 0; i < 20; i++)
    runs.recordMemoryInput(
      operation,
      { scope: {}, parameters: { index: i } },
      [],
      `memory-${i}`,
    );
  const durations = [];
  const reads = [];
  let replayRunId;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    replayRunId = runs.open(
      "benchmark",
      { replay: { runId }, versions },
      `replay-${i}`,
    ).runId;
    durations.push(performance.now() - start);
  }
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    runs.replaySnapshot(replayRunId);
    reads.push(performance.now() - start);
  }
  const snapshot = runs.replaySnapshot(replayRunId);
  assert.equal(snapshot.tasks[0].evidenceRefs.length, 100);
  assert.equal(snapshot.tasks[0].memoryRefs.length, 20);
  assert.equal(store.read(replayRunId).evidence.length, 0);
  const replayOperation = {
    ...runs.claim(
      { runId: replayRunId, identity: "benchmark" },
      "analysis",
      "claim",
    ),
    identity: "benchmark-task",
    sessionId: null,
  };
  const evidenceCopies = [];
  const memoryCopies = [];
  const savedCalls = [];
  const evidenceQuery = {
    dataset: "market",
    provider: "benchmark",
    parameters: { index: 0 },
  };
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    runs.replayEvidence(replayOperation, evidenceQuery, `evidence-${i}`);
    evidenceCopies.push(performance.now() - start);
  }
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    runs.replayMemoryInput(
      replayOperation,
      { scope: {}, parameters: { index: 0 } },
      `memory-${i}`,
    );
    memoryCopies.push(performance.now() - start);
  }
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    runs.readEvidence(
      runs.replayEvidence(replayOperation, evidenceQuery, "evidence-0"),
    );
    savedCalls.push(performance.now() - start);
  }
  assert.equal(store.read(replayRunId).evidence.length, 20);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        sourceEvidence: 100,
        sourceEvidencePayloadBytes: 1024,
        sourceMemorySnapshots: 20,
        sourceMemoryEntries: 0,
        copiedStaticPromptBytes: 1024,
        replayRuns: 20,
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        copiedEvidencePerOpen: 0,
        replayOpen: stats(durations),
        catalogRead: stats(reads),
        evidenceReplayCalls: 20,
        memoryReplayCalls: 20,
        savedCallReads: 100,
        evidenceReplay: stats(evidenceCopies),
        emptyMemoryReplay: stats(memoryCopies),
        savedCallRead: stats(savedCalls),
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
