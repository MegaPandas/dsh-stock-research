import assert from "node:assert/strict";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "tsdown";

const directory = mkdtempSync(join(tmpdir(), "dsh-evidence-benchmark-"));
const batches = 9;
const iterations = 1000;
const warmupIterations = 10_000;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function fixture(rowCount, layout, whole) {
  const times = Array.from({ length: rowCount }, (_, index) => {
    const date = new Date(Date.UTC(2010, 0, index + 1))
      .toISOString()
      .slice(0, 10);
    return { asOf: `${date}T21:00:00.000Z`, availableAt: null, complete: true };
  });
  const rows = times.map((time) => ({
    date: time.asOf.slice(0, 10),
    ...time,
    values: { close: 100 },
  }));
  const bars = times.map(({ complete, ...time }) => ({
    date: time.asOf.slice(0, 10),
    ...time,
    sessionComplete: complete,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  }));
  const index = Math.floor(rowCount / 2);
  const prefix = layout === "table" ? "/data/rows" : "/data/bars";
  const selector = whole
    ? prefix
    : `${prefix}/${index}/${layout === "table" ? "values/close" : "close"}`;
  const envelope = {
    dataset: "market",
    data:
      layout === "table"
        ? {
            table: "market.daily",
            title: "Synthetic evidence",
            columns: { close: { label: "Close", unit: "USD/share" } },
            rows,
          }
        : { currency: "USD", adjustment: "unadjusted", bars },
    source: {
      provider: "synthetic",
      url: "https://example.invalid/evidence",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: times.at(-1).asOf,
    availableAt: null,
    retrievedAt: times.at(-1).asOf,
    cutoff: times.at(-1).asOf,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
  return {
    envelope,
    selector,
    expected: {
      times: whole ? times : [times[index]],
      dependencies: whole
        ? [selector]
        : [
            selector,
            `${prefix}/${index}/asOf`,
            `${prefix}/${index}/availableAt`,
            `${prefix}/${index}/${layout === "table" ? "complete" : "sessionComplete"}`,
          ],
    },
  };
}

try {
  await build({
    config: false,
    entry: {
      fields: fileURLToPath(
        new URL("../src/evidence/fields.ts", import.meta.url),
      ),
    },
    outDir: directory,
    format: "esm",
    platform: "node",
    dts: false,
    logLevel: "silent",
  });
  const versions = [
    { name: "candidate", path: join(directory, "fields.mjs") },
    ...(process.argv[2] === undefined
      ? []
      : [{ name: "baseline", path: resolve(process.argv[2]) }]),
  ];
  for (const version of versions)
    version.referenceField = (
      await import(pathToFileURL(version.path).href)
    ).referenceField;

  const results = [];
  for (const rows of [60, 360, 3600]) {
    for (const layout of ["table", "bars"]) {
      for (const whole of [false, true]) {
        const sample = fixture(rows, layout, whole);
        const original = globalThis.structuredClone(sample.envelope);
        const timings = Object.fromEntries(
          versions.map(({ name }) => [name, []]),
        );
        for (const version of versions) {
          assert.deepEqual(
            version.referenceField(sample.envelope, sample.selector),
            sample.expected,
          );
          for (let i = 0; i < warmupIterations; i++)
            version.referenceField(sample.envelope, sample.selector);
        }
        for (let batch = 0; batch < batches; batch++) {
          const order = batch % 2 === 0 ? versions : [...versions].reverse();
          for (const version of order) {
            let result;
            const start = performance.now();
            for (let i = 0; i < iterations; i++)
              result = version.referenceField(sample.envelope, sample.selector);
            timings[version.name].push(
              (performance.now() - start) / iterations,
            );
            assert.deepEqual(result, sample.expected);
          }
        }
        assert.deepEqual(sample.envelope, original);
        const medianMs = Object.fromEntries(
          Object.entries(timings).map(([name, values]) => [
            name,
            median(values),
          ]),
        );
        results.push({
          rows,
          layout,
          scope: whole ? "whole" : "row",
          medianMs,
          ...(medianMs.baseline === undefined
            ? {}
            : { speedup: medianMs.baseline / medianMs.candidate }),
          batchMeansMs: timings,
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0]?.model,
        batches,
        iterations,
        warmupIterations,
        workload:
          "In-memory evidence reference interpretation: 60 and 360 rows plus 3600-row stress; excludes storage, sources and model calls. Versions run in alternating order.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
