import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const { DataRoot, RunStore, createRunService } = await import(core);
const samples = 5;
const taskCounts = [1, 12, 22];
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

function measure(action) {
  const read = fs.readFileSync;
  let manifestReads = 0;
  let manifestBytes = 0;
  let contentReads = 0;
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    if (String(path).endsWith("/manifest.json")) {
      manifestReads++;
      manifestBytes += Buffer.byteLength(result);
    } else if (/\/inputs\/.*\.json$/.test(String(path))) contentReads++;
    return result;
  };
  const start = performance.now();
  try {
    return {
      result: action(),
      ms: performance.now() - start,
      manifestReads,
      manifestBytes,
      contentReads,
    };
  } finally {
    fs.readFileSync = read;
  }
}

function summarize(values) {
  const median = (items) =>
    items.sort((a, b) => a - b)[Math.floor(items.length / 2)];
  return {
    medianMs: median(values.map(({ ms }) => ms)),
    manifestReadCounts: [
      ...new Set(values.map(({ manifestReads }) => manifestReads)),
    ],
    medianManifestBytes: median(
      values.map(({ manifestBytes }) => manifestBytes),
    ),
    contentReadCounts: [
      ...new Set(values.map(({ contentReads }) => contentReads)),
    ],
  };
}

const results = [];
for (const entry of [
  "claim",
  "claimService",
  "claimServiceForCall",
  "dispatchForCall",
]) {
  for (const tasks of taskCounts) {
    const directory = fs.mkdtempSync(join(tmpdir(), "dsh-claim-bench-"));
    const fresh = [];
    const replay = [];
    let root;
    try {
      root = new DataRoot(directory);
      const store = new RunStore(root);
      const runs = createRunService(store, () => "2024-01-03T00:00:00.000Z");
      const service = entry.startsWith("claimService");
      for (let sample = 0; sample < samples; sample++) {
        const { runId } = runs.open(
          "benchmark",
          {
            definition: {
              scope,
              mode: "quick",
              tasks: Array.from({ length: tasks }, (_, i) => ({
                id: `task.${i}`,
                executor: service
                  ? { kind: "service", service: "digest" }
                  : { kind: "role", role: "analyst", specialty: "benchmark" },
                dependsOn: [],
                inputTasks: [],
                outputKinds: [service ? "digest" : "analysis"],
                dataRequirements: [],
                instructionVersion: 1,
              })),
            },
            versions: {
              plugin: "benchmark",
              mode: "benchmark",
              prompts: {},
              skills: {},
              adapters: {},
              normalization: {},
            },
            inputs: [],
          },
          `open-${sample}`,
        );
        const operation = { runId, identity: "benchmark" };
        for (let i = 0; i < tasks - 1; i++)
          runs.claim(operation, `task.${i}`, `claim-${i}`);
        const taskId = `task.${tasks - 1}`;
        const action = () =>
          service
            ? runs[entry](operation, taskId, "digest", "claim-last")
            : runs[entry](operation, taskId, "claim-last");
        const claimed = measure(action);
        fresh.push(claimed);
        if (entry === "claimServiceForCall" || entry === "dispatchForCall")
          assert.equal(claimed.result.replayed, false);
        const claim = claimed.result.claim ?? claimed.result;
        runs.bindTaskSession({
          ...claim,
          identity: "benchmark",
          sessionId: "child",
        });
        const canonical = store.read(runId);
        const replayed = measure(action);
        replay.push(replayed);
        assert.deepEqual(replayed.result.claim ?? replayed.result, claim);
        if (entry === "claimServiceForCall" || entry === "dispatchForCall")
          assert.equal(replayed.result.replayed, true);
        if (entry === "dispatchForCall") {
          assert.equal(replayed.result.attempt.sessionId, "child");
          assert.equal(replayed.result.attempt.number, claim.attempt);
        }
        assert.deepEqual(store.read(runId), canonical);
      }
      results.push({
        entry,
        tasks,
        fresh: summarize(fresh),
        replay: summarize(replay),
      });
    } finally {
      try {
        root?.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
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
      workload:
        "independent tasks with prior claim receipts; no network or models",
      results,
    },
    null,
    2,
  ),
);
