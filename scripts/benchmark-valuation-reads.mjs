import assert from "node:assert/strict";
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
const { DataRoot, RunStore, createRunService, NumberService, ArtifactService } =
  await import(core);
const directory = fs.mkdtempSync(join(tmpdir(), "dsh-valuation-read-bench-"));
const samples = 20;
let root;
try {
  root = new DataRoot(directory);
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
  const claim = runs.claim(
    { runId, identity: "benchmark" },
    "analysis",
    "claim",
  );
  const operation = { ...claim, identity: "worker", sessionId: null };
  const calculations = [450, 900].map((revenue, index) => {
    const value = (revenue * 0.5) / 10;
    const registration = runs.recordValuationCalculation(
      operation,
      {
        engineVersion: "2",
        methodVersion: "synthetic",
        currency: "USD",
        valueDate: "2024-06-30",
        request: {
          methodId: "comparable_multiples",
          purpose: "valuation",
          amountUnit: "unit",
          shares: { value: 10, unit: "unit" },
          inputs: { multipleType: "ps", revenue, multiples: [0.5] },
          assumptions: ["Synthetic revenue, multiple and shares."],
          provenance: [
            { path: "/inputs", kind: "assumed", basis: "Synthetic scenario." },
            { path: "/shares", kind: "assumed", basis: "Synthetic shares." },
          ],
          sensitivities: [],
        },
        result: {
          diagnostics: [],
          equityValues: [revenue * 0.5],
          perShareValues: [value],
          shares: 10,
          steps: [],
        },
        sensitivities: [],
      },
      `calculation-${index}`,
    );
    return { ...registration, value };
  });
  const numbers = new NumberService(runs);
  const artifacts = new ArtifactService(runs, numbers);
  const before = store.read(runId);
  const measurements = [];
  for (const calculationCount of [1, 2]) {
    for (const count of [1, 20, 100]) {
      const target = {
        kind: "pending",
        contentId: `claims-${count}-${calculationCount}`,
        content: {
          kind: "analysis",
          title: "Synthetic valuation claims",
          body: "Benchmark",
          inputRefs: [],
          claims: Array.from({ length: count }, (_, index) => {
            const calculation = calculations[index % calculationCount];
            return {
              id: `value-${index}`,
              kind: "estimated",
              value: calculation.value,
              unit: "USD/share",
              calculationId: calculation.calculationId,
              method: "Synthetic PS calculation",
              assumptions: ["Synthetic revenue, multiple and shares."],
              evidence: [],
            };
          }),
          payload: {
            findings: [
              { text: "Synthetic estimates", evidence: [], numbers: [] },
            ],
            risks: [],
            gaps: [],
          },
        },
      };
      for (const [action, run, verify] of [
        [
          "number_check",
          () => numbers.checkNumbers(operation, target),
          (checked) => {
            assert.equal(checked.passed, true);
            assert.equal(checked.claims.length, count);
          },
        ],
        [
          "artifact_validation",
          () =>
            artifacts.validateArtifact(
              operation,
              [target.content],
              target.contentId,
            ),
          (checked) => {
            assert.deepEqual(checked.contents, [target.content]);
          },
        ],
      ]) {
        verify(run());
        const read = fs.readFileSync;
        let manifestReads = 0;
        let calculationReads = 0;
        fs.readFileSync = function (path, ...args) {
          const filename = String(path);
          if (filename.endsWith("/manifest.json")) manifestReads++;
          if (
            calculations.some(({ calculationId }) =>
              filename.endsWith(`/inputs/${calculationId}.json`),
            )
          )
            calculationReads++;
          return read.call(this, path, ...args);
        };
        const timings = [];
        try {
          for (let sample = 0; sample < samples; sample++) {
            const start = performance.now();
            const checked = run();
            timings.push(performance.now() - start);
            verify(checked);
          }
        } finally {
          fs.readFileSync = read;
        }
        timings.sort((a, b) => a - b);
        measurements.push({
          action,
          claims: count,
          calculations: Math.min(calculationCount, count),
          manifestReadsPerCheck: manifestReads / samples,
          calculationReadsPerCheck: calculationReads / samples,
          medianMs: timings[Math.floor(samples / 2)],
          p95Ms: timings[Math.ceil(samples * 0.95) - 1],
        });
      }
    }
  }
  assert.deepEqual(store.read(runId), before);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: cpus()[0]?.model,
        samples,
        source:
          "two synthetic registered calculations; real storage; no network or model",
        measurements,
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
