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
const body = "x".repeat(1024);
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
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    if (String(path).endsWith("/manifest.json")) {
      manifestReads++;
      manifestBytes += Buffer.byteLength(result);
    }
    return result;
  };
  const start = performance.now();
  try {
    return {
      result: action(),
      ms: performance.now() - start,
      manifestReads,
      manifestBytes,
    };
  } finally {
    fs.readFileSync = read;
  }
}

function summarize(values) {
  const times = values.map(({ ms }) => ms).sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    manifestReadCounts: [
      ...new Set(values.map(({ manifestReads }) => manifestReads)),
    ],
    medianManifestBytes: values
      .map(({ manifestBytes }) => manifestBytes)
      .sort((a, b) => a - b)[Math.floor(values.length / 2)],
  };
}

const results = [];
for (const tasks of taskCounts) {
  const timings = {
    commit: [],
    commitReplay: [],
    artifactReceipt: [],
    repair: [],
  };
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-projection-bench-"));
  let root;
  try {
    root = new DataRoot(directory);
    const store = new RunStore(root);
    const runs = createRunService(store, () => "2024-01-03T00:00:00.000Z");
    for (let sample = 0; sample < samples; sample++) {
      const { runId } = runs.open(
        "benchmark",
        {
          definition: {
            scope,
            mode: "quick",
            tasks: Array.from({ length: tasks }, (_, i) => ({
              id: `analysis.${i}`,
              executor: {
                kind: "role",
                role: "analyst",
                specialty: "benchmark",
              },
              dependsOn: [],
              inputTasks: [],
              outputKinds: ["analysis"],
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
        `open-${tasks}-${sample}`,
      );
      for (let i = 0; i < tasks; i++) {
        const claim = runs.claim(
          { runId, identity: "benchmark" },
          `analysis.${i}`,
          `claim-${i}`,
        );
        const operation = {
          ...claim,
          identity: "benchmark-worker",
          sessionId: null,
        };
        const content = [
          {
            kind: "analysis",
            title: `Analysis ${i}`,
            body,
            inputRefs: [],
            claims: [],
            payload: {},
          },
        ];
        if (i < tasks - 1) {
          runs.commitArtifact(operation, content, `submit-${i}`);
          continue;
        }
        const committed = measure(() =>
          runs.commitArtifact(operation, content, `submit-${i}`),
        );
        timings.commit.push(committed);
        const canonical = store.read(runId);
        const replayed = measure(() =>
          runs.commitArtifact(operation, content, `submit-${i}`),
        );
        const receipt = measure(() =>
          runs.artifactForCall(operation, content, `submit-${i}`),
        );
        const repaired = measure(() => runs.repairProjections(runId));
        timings.commitReplay.push(replayed);
        timings.artifactReceipt.push(receipt);
        timings.repair.push(repaired);
        assert.deepEqual(replayed.result, committed.result);
        assert.deepEqual(receipt.result, committed.result);
        assert.deepEqual(store.read(runId), canonical);
        assert.ok(
          fs
            .readFileSync(
              join(
                directory,
                "runs",
                scope.date,
                `US_NVDA-quick-${runId}`,
                "reports",
                `analysis.${i}.md`,
              ),
              "utf8",
            )
            .includes(body),
        );
      }
    }
    results.push({
      tasks,
      ...Object.fromEntries(
        Object.entries(timings).map(([key, values]) => [
          key,
          summarize(values),
        ]),
      ),
    });
  } finally {
    try {
      root?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
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
      bodyBytes: Buffer.byteLength(body),
      workload: "synthetic task outputs; no network or models",
      results,
    },
    null,
    2,
  ),
);
