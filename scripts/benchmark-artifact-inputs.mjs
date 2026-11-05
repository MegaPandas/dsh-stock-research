import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "tsdown";

const directory = fs.mkdtempSync(join(tmpdir(), "dsh-artifact-inputs-bench-"));
const batches = 9;
const iterations = 50;
const warmupIterations = 100;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function readCounts(action) {
  const read = fs.readFileSync;
  const counts = { manifest: 0, artifact: 0 };
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    const filename = String(path);
    if (filename.endsWith("/manifest.json")) counts.manifest++;
    else if (/\/artifacts\/.*\.json$/.test(filename)) counts.artifact++;
    return result;
  };
  try {
    return { result: action(), counts };
  } finally {
    fs.readFileSync = read;
  }
}

let root;
try {
  await build({
    config: false,
    entry: {
      core: fileURLToPath(new URL("../src/core.ts", import.meta.url)),
      inputs: fileURLToPath(
        new URL("../src/services/artifact-inputs.ts", import.meta.url),
      ),
    },
    outDir: join(directory, "build"),
    format: "esm",
    platform: "node",
    deps: { alwaysBundle: ["ajv"] },
    dts: false,
    logLevel: "silent",
  });
  const {
    DataRoot,
    RunStore,
    createRunService,
    ArtifactService,
    NumberService,
  } = await import(pathToFileURL(join(directory, "build/core.mjs")).href);
  const versions = [
    { name: "candidate", path: join(directory, "build/inputs.mjs") },
    ...(process.argv[2] === undefined
      ? []
      : [{ name: "baseline", path: resolve(process.argv[2]) }]),
  ];
  for (const version of versions)
    version.Inputs = (
      await import(pathToFileURL(version.path).href)
    ).ArtifactInputs;

  root = new DataRoot(join(directory, "data"));
  const runs = createRunService(
    new RunStore(root),
    () => "2024-07-01T12:00:00.000Z",
  );
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  const results = [];
  for (const width of [1, 4, 12]) {
    const task = (id, dependsOn = []) => ({
      id,
      executor: { kind: "role", role: "analyst", specialty: "synthetic" },
      dependsOn,
      inputTasks: dependsOn,
      outputKinds: ["analysis"],
      dataRequirements: [],
      instructionVersion: 1,
    });
    const middle = Array.from({ length: width }, (_, index) =>
      task(`middle-${index}`, ["leaf"]),
    );
    const top = Array.from({ length: width }, (_, index) =>
      task(
        `top-${index}`,
        middle.map(({ id }) => id),
      ),
    );
    const tasks = [task("leaf"), ...middle, ...top];
    const { runId } = runs.open(
      "benchmark",
      {
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
            date: "2024-06-30",
            cutoff: "2024-06-30T20:00:00.000Z",
          },
          mode: "quick",
          tasks,
        },
        versions: {
          plugin: "synthetic",
          mode: "synthetic",
          prompts: {},
          skills: {},
          adapters: {},
          normalization: {},
        },
        inputs: [],
      },
      `width-${width}`,
    );
    const refs = new Map();
    for (const { id } of tasks) {
      const claim = runs.claim(
        { runId, identity: "benchmark" },
        id,
        `claim-${id}`,
      );
      const saved = artifacts.submitArtifact(
        { ...claim, identity: "worker", sessionId: null },
        [
          {
            kind: "analysis",
            title: id,
            body: "Synthetic analysis.",
            inputRefs: claim.inputRefs,
            claims: [],
            payload: {
              findings: [
                { text: "Synthetic observation.", evidence: [], numbers: [] },
              ],
              risks: [],
              gaps: [],
            },
          },
        ],
        `submit-${id}`,
      );
      refs.set(id, saved.refs[0]);
    }
    const roots = top.map(({ id }) => refs.get(id));
    const expected = [...top, ...middle, { id: "leaf" }].map(({ id }) =>
      runs.readArtifact(refs.get(id)),
    );
    const measurements = {};
    const timings = Object.fromEntries(versions.map(({ name }) => [name, []]));
    for (const { name, Inputs } of versions) {
      const { result, counts } = readCounts(() =>
        new Inputs(runs).closure(roots),
      );
      assert.deepEqual(result, expected);
      assert.equal(counts.artifact, expected.length);
      measurements[name] = { reads: counts };
      for (let i = 0; i < warmupIterations; i++)
        new Inputs(runs).closure(roots);
    }
    for (let batch = 0; batch < batches; batch++) {
      for (const { name, Inputs } of batch % 2 === 0
        ? versions
        : [...versions].reverse()) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) new Inputs(runs).closure(roots);
        timings[name].push((performance.now() - start) / iterations);
      }
    }
    for (const { name } of versions) {
      measurements[name].medianMs = median(timings[name]);
      measurements[name].samplesMs = timings[name];
    }
    results.push({ width, artifacts: expected.length, measurements });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0]?.model,
        fixture:
          "three dependency layers with shared inputs; real run/artifact services and local storage; fresh operation cache per read; no network or model calls",
        batches,
        iterations,
        warmupIterations,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    root?.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
