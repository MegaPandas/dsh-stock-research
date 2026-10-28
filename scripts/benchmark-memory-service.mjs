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
  MemoryService,
  MemoryStore,
  RunService,
  RunStore,
} from "dsh-stock-research/core";

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
try {
  root = new DataRoot(directory);
  const runs = new RunService(new RunStore(root), () => cutoff);
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
  memory = new MemoryService(
    new MemoryStore(root, () => ({ stateVersion: 1, receipts: [] })),
    runs,
    async () => {
      sourceRequests++;
      throw new Error("Benchmark must not query returns.");
    },
    () => recordedAt,
  );
  const additions = [];
  const revisions = [];
  const recall = [];
  const receiptReplay = [];
  const snapshots = [];
  const snapshotReplay = [];
  const refs = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    refs.push(await memory.remember(operation, input, `remember-${index}`));
    additions.push(performance.now() - start);
  }
  recordedAt = "2024-01-03T00:00:00.000Z";
  for (let index = 0; index < 5; index++) {
    const start = performance.now();
    await memory.remember(
      operation,
      { ...input, previous: refs[index], note: "y".repeat(1024) },
      `revise-${index}`,
    );
    revisions.push(performance.now() - start);
  }
  const query = { runId, text: "Synthetic review", limit: 20 };
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const found = memory.recall(scope, query);
    recall.push(performance.now() - start);
    assert.equal(found.length, 20);
    assert.ok(
      found.every(
        (entry) => entry.ref.revision === 1 && entry.content.note === note,
      ),
    );
  }
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const ref = await memory.remember(operation, input, "remember-0");
    receiptReplay.push(performance.now() - start);
    assert.deepEqual(ref, refs[0]);
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
        remember: stats(additions),
        revise: stats(revisions),
        cutoffRecall: stats(recall),
        rememberReceiptReplay: stats(receiptReplay),
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
