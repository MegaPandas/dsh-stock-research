import assert from "node:assert/strict";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "tsdown";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc.");
const directory = mkdtempSync(join(tmpdir(), "dsh-quality-benchmark-"));
const batches = 9;
const iterations = 200;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function envelope(rowCount, missing) {
  const fields = ["open", "high", "low", "close", "volume"];
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const date = new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10);
    return {
      date,
      asOf: `${date}T07:00:00.000Z`,
      availableAt: null,
      complete: true,
      values: Object.fromEntries(
        fields.map((field) => [
          field,
          missing === "all" || (field === "volume" && i < missing) ? null : 100,
        ]),
      ),
    };
  });
  const time = rows.at(-1).asOf;
  return {
    dataset: "market",
    data: {
      table: "market.daily",
      title: "Synthetic quality sample",
      columns: Object.fromEntries(
        fields.map((field) => [field, { label: field, unit: "CNY" }]),
      ),
      rows,
    },
    source: {
      provider: "fixture",
      url: "https://example.invalid/table",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: time,
    availableAt: null,
    retrievedAt: time,
    cutoff: time,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}

try {
  let entry;
  if (process.argv[2] === undefined) {
    await build({
      config: false,
      entry: {
        quality: fileURLToPath(
          new URL("../src/services/collection/quality.ts", import.meta.url),
        ),
      },
      outDir: directory,
      format: "esm",
      platform: "node",
      dts: false,
      logLevel: "silent",
    });
    entry = join(directory, "quality.mjs");
  } else entry = resolve(process.argv[2]);
  const quality = await import(pathToFileURL(entry).href);
  function select(candidates) {
    let selected;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (quality.collectionCoverageIssue(candidate) === undefined) return i;
      if (
        selected === undefined ||
        quality.improvesCollectionCoverage(selected.envelope, candidate)
      )
        selected = { index: i, envelope: candidate };
    }
    return selected.index;
  }
  const results = [];
  for (const rows of [12, 60, 360]) {
    const partial = [
      envelope(rows, Math.floor(rows * 0.75)),
      envelope(rows, Math.floor(rows / 2)),
      envelope(rows, 1),
    ];
    const rejected = partial.map((candidate, index) => ({
      ...candidate,
      stale: index > 0,
    }));
    for (const [scenario, candidates, expected] of [
      ["complete", [envelope(rows, 0)], 0],
      ["single_sparse_partial", [envelope(rows, "all")], 0],
      ["improving_partials", partial, 2],
      ["reject_stale_partials", rejected, 0],
    ]) {
      const original = globalThis.structuredClone(candidates);
      assert.equal(select(candidates), expected);
      assert.deepEqual(candidates, original);
      for (let i = 0; i < 50; i++) select(candidates);
      const times = [],
        heapIncreases = [];
      for (let batch = 0; batch < batches; batch++) {
        globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        const selected = select(candidates);
        heapIncreases.push(process.memoryUsage().heapUsed - before);
        assert.equal(selected, expected);
        const start = performance.now();
        for (let i = 0; i < iterations; i++) select(candidates);
        times.push((performance.now() - start) / iterations);
      }
      results.push({
        rows,
        scenario,
        candidates: candidates.length,
        medianMs: median(times),
        medianHeapIncreaseBytes: median(heapIncreases),
        batchMeansMs: times,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0]?.model,
        batches,
        iterations,
        workload:
          "Pure quality evaluation and partial selection; 12 and 60 row tables plus 360-row stress; no source, cache, storage or model calls. Heap delta is growth for one selection after GC.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
