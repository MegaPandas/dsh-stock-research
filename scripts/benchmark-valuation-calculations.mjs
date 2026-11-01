import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "tsdown";

const directory = fs.mkdtempSync(
  join(tmpdir(), "dsh-valuation-calculation-bench-"),
);
const samples = 5;
const request = {
  methodId: "comparable_multiples",
  purpose: "valuation",
  amountUnit: "unit",
  shares: { value: 10, unit: "unit" },
  inputs: { multipleType: "ps", revenue: 450, multiples: [0.5] },
  assumptions: ["Synthetic revenue, shares and multiple."],
  provenance: [
    { path: "/inputs", kind: "assumed", basis: "Synthetic scenario." },
    { path: "/shares", kind: "assumed", basis: "Synthetic shares." },
  ],
  sensitivities: [],
};

function measure(action) {
  const read = fs.readFileSync;
  let manifestReads = 0;
  let manifestBytes = 0;
  let inputReads = 0;
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    if (String(path).endsWith("/manifest.json")) {
      manifestReads++;
      manifestBytes += Buffer.byteLength(result);
    } else if (/\/inputs\/.*\.json$/.test(String(path))) inputReads++;
    return result;
  };
  const start = performance.now();
  try {
    return {
      result: action(),
      ms: performance.now() - start,
      manifestReads,
      manifestBytes,
      inputReads,
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
    inputReadCounts: [...new Set(values.map(({ inputReads }) => inputReads))],
  };
}

try {
  let entry;
  if (process.argv[2] === undefined) {
    await build({
      config: false,
      entry: {
        valuation: fileURLToPath(
          new URL("./fixtures/valuation-calculations.ts", import.meta.url),
        ),
      },
      outDir: join(directory, "bundle"),
      format: "esm",
      platform: "node",
      dts: false,
      deps: { alwaysBundle: ["ajv"] },
      logLevel: "silent",
    });
    entry = join(directory, "bundle", "valuation.mjs");
  } else entry = resolve(process.argv[2]);
  const {
    DataRoot,
    RunStore,
    createRunService,
    calculateValuation,
    catalogue,
    VALUATION_ENGINE_VERSION,
    VALUATION_METHODS_INPUT,
  } = await import(pathToFileURL(entry).href);
  const results = [];
  for (const priorCalculations of [0, 20, 100]) {
    const root = new DataRoot(join(directory, `data-${priorCalculations}`));
    try {
      const store = new RunStore(root);
      const runs = createRunService(store, () => "2024-07-01T12:00:00.000Z");
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
            tasks: [
              {
                id: "analysis",
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
              },
            ],
          },
          versions: {
            plugin: "benchmark",
            mode: "benchmark",
            prompts: {
              valuationEngine: VALUATION_ENGINE_VERSION,
              valuationMethods: catalogue.version,
            },
            skills: {},
            adapters: {},
            normalization: {},
          },
          inputs: [{ name: VALUATION_METHODS_INPUT, content: catalogue }],
        },
        "open",
      );
      const operation = {
        ...runs.claim({ runId, identity: "benchmark" }, "analysis", "claim"),
        identity: "worker",
        sessionId: null,
      };
      for (let i = 0; i < priorCalculations; i++)
        calculateValuation(runs, operation, request, `prior-${i}`);
      const fresh = [];
      const replay = [];
      for (let i = 0; i < samples; i++) {
        const action = () =>
          calculateValuation(runs, operation, request, `measure-${i}`);
        const calculated = measure(action);
        fresh.push(calculated);
        assert.deepEqual(calculated.result.result.perShareValues, [22.5]);
        assert.equal(calculated.result.createdAt, "2024-07-01T12:00:00.000Z");
        const canonical = store.read(runId);
        const repeated = measure(action);
        replay.push(repeated);
        assert.deepEqual(repeated.result, calculated.result);
        assert.deepEqual(store.read(runId), canonical);
      }
      assert.equal(
        runs
          .inputCatalog(runId)
          .inputs.filter(({ calculation }) => calculation !== undefined).length,
        priorCalculations + samples,
      );
      results.push({
        priorCalculations,
        fresh: summarize(fresh),
        replay: summarize(replay),
      });
    } finally {
      root.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: cpus()[0]?.model,
        samples,
        workload:
          "independent PS calculations; growing registry; real storage; no network or models",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
