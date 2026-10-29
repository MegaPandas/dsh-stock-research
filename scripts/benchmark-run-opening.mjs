import console from "node:console";
import fs from "node:fs";
import { Buffer } from "node:buffer";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const { DataRoot, RunStore, RunService } = await import(core);
const historySizes = [0, 100, 500];
const samples = 5;
const tasksPerRun = 20;
const now = () => "2024-01-02T22:00:00.000Z";
const input = {
  definition: {
    scope: {
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
    },
    mode: "quick",
    tasks: Array.from({ length: tasksPerRun }, (_, i) => ({
      id: `analysis.${i}`,
      executor: { kind: "role", role: "analyst", specialty: "market" },
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
  inputs: [
    {
      name: "instructions",
      content: "Synthetic persisted research; no models or network.",
    },
  ],
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
  const started = performance.now();
  try {
    const value = action();
    return {
      value,
      ms: performance.now() - started,
      manifestReads,
      manifestBytes,
    };
  } finally {
    fs.readFileSync = read;
  }
}

function summarize(values) {
  const sorted = values.map(({ ms }) => ms).sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    manifestReadCounts: [
      ...new Set(values.map(({ manifestReads }) => manifestReads)),
    ],
    manifestReadBytes: [
      ...new Set(values.map(({ manifestBytes }) => manifestBytes)),
    ],
  };
}

const cases = [];
for (const historyRuns of historySizes) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-opening-bench-"));
  let root;
  try {
    console.error(`Preparing ${historyRuns} historical runs.`);
    root = new DataRoot(directory);
    const seed = new RunService(new RunStore(root), now);
    for (let i = 0; i < historyRuns; i++)
      seed.open("benchmark", input, `history-${i}`);
    root.close();
    const startup = [];
    const opening = [];
    for (let i = 0; i < samples; i++) {
      root = new DataRoot(directory);
      const initialized = measure(
        () => new RunService(new RunStore(root), now),
      );
      startup.push(initialized);
      const opened = measure(() =>
        initialized.value.open("benchmark", input, `sample-${i}`),
      );
      opening.push(opened);
      root.close();
      // Each sample sees exactly the same history; only synthetic data is removed.
      fs.rmSync(
        join(
          directory,
          "runs",
          input.definition.scope.date,
          `US_NVDA-quick-${opened.value.runId}`,
        ),
        { recursive: true },
      );
    }
    cases.push({
      historyRuns,
      startup: summarize(startup),
      newRequest: summarize(opening),
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
      core,
      samples,
      tasksPerRun,
      measuredStartup:
        "RunStore and RunService construction, excluding DataRoot lock acquisition",
      cases,
    },
    null,
    2,
  ),
);
