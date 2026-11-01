import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const { DataRoot, MemoryService, MemoryStore, createRunService, RunStore } =
  await import(core);

const directory = mkdtempSync(join(tmpdir(), "dsh-memory-service-bench-"));
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
const note = "x".repeat(1024);
const input = {
  previous: null,
  outcome: "Synthetic review",
  note,
  evidence: [],
  returns: {
    kind: "unavailable",
    gaps: [
      {
        code: "missing",
        field: "/returns",
        detail: "Synthetic fixture has no return observations.",
      },
    ],
  },
};
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
let root;
let memory;
function countReads() {
  const read = fs.readFileSync;
  const reads = { indexReads: 0, indexBytes: 0, entryReads: 0 };
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    const filename = String(path);
    if (filename.endsWith("/memory/index.json")) {
      reads.indexReads++;
      reads.indexBytes += Buffer.byteLength(result);
    } else if (filename.includes("/memory/entries/")) reads.entryReads++;
    return result;
  };
  return {
    reads,
    restore: () => {
      fs.readFileSync = read;
    },
  };
}
async function measureWrite(action) {
  const counter = countReads();
  const start = performance.now();
  try {
    return {
      result: await action(),
      ms: performance.now() - start,
      reads: counter.reads,
    };
  } finally {
    counter.restore();
  }
}
function readStats(samples) {
  for (const value of samples) {
    assert.equal(value.indexReads, samples[0].indexReads);
    assert.equal(value.entryReads, samples[0].entryReads);
  }
  return {
    indexReadsPerCall: samples[0].indexReads,
    indexBytesPerCall:
      samples.reduce((sum, value) => sum + value.indexBytes, 0) /
      samples.length,
    entryReadsPerCall: samples[0].entryReads,
  };
}
function measureRecall(query, refs, samples = 30) {
  const counter = countReads();
  const times = [];
  try {
    for (let sample = 0; sample < samples; sample++) {
      const start = performance.now();
      const found = memory.recall(scope, query);
      times.push(performance.now() - start);
      assert.deepEqual(
        found
          .map(({ ref }) => ref)
          .sort((a, b) => a.entryId.localeCompare(b.entryId)),
        [...refs].sort((a, b) => a.entryId.localeCompare(b.entryId)),
      );
      assert.ok(found.every((entry) => entry.content.note === note));
    }
  } finally {
    counter.restore();
  }
  return {
    ...stats(times),
    indexReadsPerRecall: counter.reads.indexReads / samples,
    indexBytesPerRecall: counter.reads.indexBytes / samples,
    entryReadsPerRecall: counter.reads.entryReads / samples,
  };
}
try {
  root = new DataRoot(directory);
  const runs = createRunService(new RunStore(root), () => cutoff);
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
  const taskOperation = {
    runId,
    identity: "benchmark-task",
    taskId: "analysis",
    attempt: claimed.attempt,
    sessionId: null,
  };
  const operation = { runId, identity: "benchmark", scope };
  let sourceRequests = 0;
  let recordedAt = cutoff;
  const store = new MemoryStore(root, () => ({
    stateVersion: 1,
    receipts: [],
  }));
  memory = new MemoryService(
    store,
    runs,
    async () => {
      sourceRequests++;
      throw new Error("Benchmark must not query returns.");
    },
    () => recordedAt,
  );
  const additions = [];
  const revisions = [];
  const receiptReplay = [];
  const additionReads = [];
  const revisionReads = [];
  const replayReads = [];
  const snapshots = [];
  const snapshotReplay = [];
  const refs = [];
  for (let index = 0; index < 20; index++) {
    const measured = await measureWrite(() =>
      memory.remember(operation, input, `remember-${index}`),
    );
    refs.push(measured.result);
    additions.push(measured.ms);
    additionReads.push(measured.reads);
  }
  const heads = [...refs];
  recordedAt = "2024-01-03T00:00:00.000Z";
  for (let index = 0; index < 5; index++) {
    const measured = await measureWrite(() =>
      memory.remember(
        operation,
        { ...input, previous: refs[index], note: "y".repeat(1024) },
        `revise-${index}`,
      ),
    );
    heads[index] = measured.result;
    revisions.push(measured.ms);
    revisionReads.push(measured.reads);
  }
  const query = { runId, text: "Synthetic review", limit: 20 };
  const recall = measureRecall(query, refs);
  for (let index = 0; index < 30; index++) {
    const measured = await measureWrite(() =>
      memory.remember(operation, input, "remember-0"),
    );
    receiptReplay.push(measured.ms);
    replayReads.push(measured.reads);
    assert.deepEqual(measured.result, refs[0]);
  }
  let snapshot;
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    snapshot = memory.recallForTask(taskOperation, query, `snapshot-${index}`);
    snapshots.push(performance.now() - start);
    assert.equal(snapshot.entries.length, 20);
  }
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const replayed = memory.recallForTask(taskOperation, query, "snapshot-9");
    snapshotReplay.push(performance.now() - start);
    assert.deepEqual(replayed, snapshot);
  }
  const historicalRecall = [];
  for (const depth of [3, 12]) {
    for (let index = 0; index < heads.length; index++) {
      while (heads[index].revision < depth) {
        const previous = heads[index];
        heads[index] = await memory.remember(
          operation,
          { ...input, previous, note: "Future revision" },
          `history-${index}-${previous.revision}`,
        );
      }
    }
    const before = store.readIndex();
    historicalRecall.push({
      revisionsPerEntry: depth,
      ...measureRecall(query, refs),
    });
    assert.deepEqual(store.readIndex(), before);
  }
  assert.equal(sourceRequests, 0);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        fixture:
          "synthetic manually opened run, real temporary local storage, unavailable returns; no network",
        modelRequests: 0,
        sourceRequests,
        entries: 20,
        revisions: 5,
        noteBytes: Buffer.byteLength(note),
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        remember: { ...stats(additions), ...readStats(additionReads) },
        revise: { ...stats(revisions), ...readStats(revisionReads) },
        cutoffRecall: recall,
        historicalRecall,
        rememberReceiptReplay: {
          ...stats(receiptReplay),
          ...readStats(replayReads),
        },
        taskSnapshot: stats(snapshots),
        taskSnapshotReplay: stats(snapshotReplay),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await memory?.close();
  } finally {
    try {
      root?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
