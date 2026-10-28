import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  ArtifactService,
  DataRoot,
  NumberService,
  RunService,
  RunStore,
} from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-numbers-bench-"));
const cutoff = "2024-01-02T21:00:00.000Z";
let root;
try {
  root = new DataRoot(directory);
  const store = new RunStore(root);
  const runs = new RunService(store, () => "2024-01-03T00:00:00.000Z");
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
          date: "2024-01-02",
          cutoff,
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
  const operation = { ...claimed, identity: "benchmark-task", sessionId: null };
  // Explicitly synthetic known-by snapshot; no source adapter is called.
  const frame = {
    dataset: "market",
    data: {
      currency: "USD",
      adjustment: "split_adjusted",
      bars: [
        {
          date: "2024-01-02",
          asOf: cutoff,
          availableAt: cutoff,
          sessionComplete: true,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
        },
      ],
    },
    source: {
      provider: "synthetic",
      url: "https://example.com/benchmark",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: cutoff,
    availableAt: cutoff,
    cutoff,
    retrievedAt: cutoff,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "verified",
    gaps: [],
  };
  const source = runs.recordEvidence(
    operation,
    {
      dataset: "market",
      provider: "synthetic",
      parameters: { maxAgeMs: 60_000 },
    },
    { envelope: frame, candidates: [] },
    "data",
  );
  const numbers = new NumberService(runs);
  const before = store.read(runId);
  const samples = 30;
  const measurements = [100, 1000].map((count) => {
    const target = {
      kind: "pending",
      contentId: `claims-${count}`,
      content: {
        kind: "analysis",
        title: "Synthetic numeric benchmark",
        body: "Benchmark",
        inputRefs: [],
        claims: Array.from({ length: count }, (_, index) => ({
          id: `price-${index}`,
          kind: "observed",
          value: 100,
          unit: "USD/share",
          source: { ...source, selector: "/data/bars/0/close" },
        })),
        payload: {},
      },
    };
    assert.equal(numbers.checkNumbers(operation, target).passed, true);
    const timings = Array.from({ length: samples }, () => {
      const start = performance.now();
      const report = numbers.checkNumbers(operation, target);
      const elapsed = performance.now() - start;
      assert.equal(report.passed, true);
      assert.equal(report.claims.length, count);
      return elapsed;
    }).sort((a, b) => a - b);
    return {
      claims: count,
      targetBytes: Buffer.byteLength(JSON.stringify(target)),
      medianMs: timings[Math.floor(samples / 2)],
      p95Ms: timings[Math.ceil(samples * 0.95) - 1],
    };
  });
  assert.deepEqual(store.read(runId), before);
  const submitter = new ArtifactService(runs, numbers);
  const content = {
    kind: "analysis",
    title: "Submission benchmark",
    body: "Price {{number:price-0}}.",
    inputRefs: [],
    claims: Array.from({ length: 1000 }, (_, index) => ({
      id: `price-${index}`,
      kind: "observed",
      value: 100,
      unit: "USD/share",
      source: { ...source, selector: "/data/bars/0/close" },
    })),
    payload: {
      findings: [
        {
          text: "Synthetic observation",
          evidence: [],
          numbers: [{ kind: "local", claimId: "price-0" }],
        },
      ],
      risks: [],
      gaps: [],
    },
  };
  const submitStart = performance.now();
  const committed = submitter.submitArtifact(operation, [content], "submit");
  const submitMs = performance.now() - submitStart;
  assert.equal(committed.refs.length, 1);
  const repeated = Array.from({ length: samples }, () => {
    const start = performance.now();
    const result = submitter.submitArtifact(operation, [content], "submit");
    const elapsed = performance.now() - start;
    assert.deepEqual(result, committed);
    return elapsed;
  }).sort((a, b) => a - b);
  assert.equal(store.read(runId).artifacts.length, 1);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        samples,
        source:
          "one synthetic registered snapshot; real local storage; no source requests or model calls",
        evidenceBytes: Buffer.byteLength(
          JSON.stringify(runs.readEvidence(source)),
        ),
        measurements,
        artifactSubmission: {
          claims: 1000,
          contentBytes: Buffer.byteLength(JSON.stringify(content)),
          submitMs,
          repeatedCalls: samples,
          repeatMedianMs: repeated[Math.floor(samples / 2)],
          repeatP95Ms: repeated[Math.ceil(samples * 0.95) - 1],
          includes:
            "schema, references, numeric gate, atomic commit and rendered projection; repeats replay receipt and repair projection",
        },
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
