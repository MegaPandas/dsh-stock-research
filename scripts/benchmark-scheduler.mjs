import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const core = await import(
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href
);
const mode = process.argv[3] ?? "both";
assert.ok(["wave", "scheduler", "both"].includes(mode));
const modes = mode === "both" ? ["wave", "scheduler"] : [mode];
const samples = 5;
// Freeze these workloads before measuring either implementation.
const workloads = [
  {
    name: "independent-branch",
    slowMs: 30,
    fastMs: 2,
    followMs: 10,
    tailMs: 0,
  },
  { name: "committed-tail", slowMs: 10, fastMs: 2, followMs: 10, tailMs: 30 },
];
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
const tasks = [
  ...["slow", "fast", "follow"].map((id) => ({
    id,
    executor: { kind: "role", role: "analyst", specialty: "benchmark" },
    dependsOn: id === "follow" ? ["fast"] : [],
    inputTasks: [],
    outputKinds: ["analysis"],
    dataRequirements: [],
    instructionVersion: 1,
  })),
  {
    id: "finalize",
    executor: { kind: "service", service: "finalize" },
    dependsOn: ["slow", "fast", "follow"],
    inputTasks: [],
    outputKinds: ["decision", "report"],
    dataRequirements: [],
    instructionVersion: 1,
  },
];
const artifact = (kind) => ({
  kind,
  title: kind,
  body: "Synthetic benchmark",
  inputRefs: [],
  claims: [],
  payload: {},
});

async function sample(entry, workload) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-scheduler-bench-"));
  let root;
  let scheduler;
  const executions = [];
  const read = fs.readFileSync;
  let manifestReads = 0;
  let manifestBytes = 0;
  let scans = 0;
  let active = 0;
  let maxActive = 0;
  const starts = {};
  const commits = {};
  const counts = {};
  try {
    root = new core.DataRoot(directory);
    const runs = core.createRunService(
      new core.RunStore(root),
      () => "2024-01-03T00:00:00.000Z",
    );
    const { runId } = runs.open(
      "benchmark",
      {
        definition: { scope, mode: "quick", tasks },
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
      "open",
    );
    const operation = { runId, identity: "benchmark" };
    const execute = (selection, signal) => {
      const execution = (async () => {
        assert.equal(selection.kind, "task");
        const { taskId } = selection;
        counts[taskId] = (counts[taskId] ?? 0) + 1;
        assert.equal(counts[taskId], 1);
        starts[taskId] = performance.now() - start;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          const claim =
            taskId === "finalize"
              ? runs.claimService(
                  operation,
                  taskId,
                  "finalize",
                  selection.requestId,
                )
              : runs.claim(operation, taskId, selection.requestId);
          const taskOperation = {
            ...claim,
            identity: "benchmark",
            sessionId: null,
          };
          if (taskId === "finalize") {
            assert.ok(
              runs
                .view({ runId })
                .tasks.every(
                  (task) =>
                    task.taskId === "finalize" || task.status === "succeeded",
                ),
            );
            runs.finalize(
              taskOperation,
              artifact("decision"),
              artifact("report"),
              "submit",
            );
          } else {
            await setTimeout(workload[`${taskId}Ms`], undefined, { signal });
            runs.commitArtifact(
              taskOperation,
              [artifact("analysis")],
              "submit",
            );
          }
          commits[taskId] = performance.now() - start;
          if (taskId === "fast" && workload.tailMs > 0)
            await setTimeout(workload.tailMs, undefined, { signal });
        } finally {
          active--;
        }
      })();
      executions.push(execution);
      return execution;
    };
    fs.readFileSync = function (path, ...args) {
      const result = read.call(this, path, ...args);
      if (String(path).endsWith("/manifest.json")) {
        manifestReads++;
        manifestBytes += Buffer.byteLength(result);
      }
      return result;
    };
    const start = performance.now();
    if (entry === "wave") {
      for (;;) {
        scans++;
        const view = runs.view({ runId });
        if (view.status === "completed") break;
        const ready = tasks.filter(
          (task) =>
            view.readyTasks.includes(task.id) &&
            view.tasks.find(({ taskId }) => taskId === task.id).status ===
              "pending",
        );
        assert.ok(ready.length > 0, "Wave made no progress");
        const settled = await Promise.allSettled(
          ready.map((task) =>
            execute(
              {
                kind: "task",
                taskId: task.id,
                executor: task.executor,
                requestId: `claim-${task.id}`,
              },
              undefined,
            ),
          ),
        );
        const failures = settled.filter(({ status }) => status === "rejected");
        if (failures.length)
          throw new AggregateError(failures.map(({ reason }) => reason));
      }
    } else {
      scheduler = new core.RunScheduler(runId, {
        runs,
        execute,
        onChange: () => {
          scans++;
        },
      });
      await scheduler.start();
    }
    await Promise.all(executions);
    const ms = performance.now() - start;
    fs.readFileSync = read;
    assert.equal(runs.view({ runId }).status, "completed");
    assert.equal(active, 0);
    for (const task of tasks) assert.equal(counts[task.id], 1);
    assert.ok(starts.follow >= commits.fast);
    return {
      ms,
      scans,
      manifestReads,
      manifestBytes,
      maxActive,
      followWaitMs: starts.follow - commits.fast,
      starts,
      commits,
    };
  } finally {
    try {
      await scheduler?.close();
    } finally {
      await Promise.allSettled(executions);
      fs.readFileSync = read;
      try {
        root?.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const entry of modes) {
  for (const workload of workloads) {
    const measurements = [];
    for (let i = 0; i < samples; i++)
      measurements.push(await sample(entry, workload));
    results.push({
      entry,
      workload: workload.name,
      medianMs: median(measurements.map(({ ms }) => ms)),
      medianScans: median(measurements.map(({ scans }) => scans)),
      manifestReadCounts: [
        ...new Set(measurements.map(({ manifestReads }) => manifestReads)),
      ],
      medianManifestBytes: median(
        measurements.map(({ manifestBytes }) => manifestBytes),
      ),
      maxActiveCounts: [
        ...new Set(measurements.map(({ maxActive }) => maxActive)),
      ],
      medianFollowWaitMs: median(
        measurements.map(({ followWaitMs }) => followWaitMs),
      ),
      measurements,
    });
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
      workloads,
      workload:
        "Fixed synthetic scheduling and cleanup waits; no network, models, or production data",
      results,
    },
    null,
    2,
  ),
);
