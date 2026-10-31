import assert from "node:assert/strict";
import console from "node:console";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const entry =
  process.argv[2] === undefined
    ? new URL("../src/services/collection/view.ts", import.meta.url)
    : pathToFileURL(resolve(process.argv[2]));
const { readCollectionTable, readCollectionData } = await import(entry.href);
assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc.");
const batches = 9;
const iterations = 100;
const pageSize = 10;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];

for (const rowCount of [60, 360, 10_000]) {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const date = new Date(Date.UTC(1990, 0, index + 1))
      .toISOString()
      .slice(0, 10);
    return {
      date,
      asOf: `${date}T07:30:00.000Z`,
      availableAt: null,
      complete: true,
      values: { value: index, ignored: index * 2 },
    };
  });
  const asOf = rows.at(-1).asOf;
  const source = {
    id: "market.daily",
    sourceRef: {
      runId: "fixture-run",
      evidenceId: "fixture-table",
      selector: "/data",
    },
    envelope: {
      dataset: "market",
      data: {
        table: "market.daily",
        title: "Synthetic page benchmark",
        columns: {
          value: { label: "Value", unit: "CNY" },
          ignored: { label: "Unselected", unit: "CNY" },
        },
        rows,
      },
      source: {
        provider: "fixture",
        url: "https://example.invalid/table",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf,
      availableAt: null,
      retrievedAt: asOf,
      cutoff: asOf,
      ageMs: 0,
      stale: false,
      historicalKnowledge: "unverified",
      gaps: [],
    },
  };
  const first = Math.floor(rowCount / 4);
  const last = Math.floor((rowCount * 3) / 4);
  const total = last - first + 1;
  const request = {
    kind: "rows",
    table: source.id,
    fields: ["value"],
    offset: 2,
    limit: pageSize,
    dateFrom: rows[first].date,
    dateTo: rows[last].date,
  };
  for (const [mode, read] of [
    ["references", readCollectionTable],
    ["business", readCollectionData],
  ]) {
    const expectedIndices = Array.from(
      { length: pageSize },
      (_, index) => first + 2 + index,
    );
    const check = (view) => {
      assert.equal(view.totalRows, total);
      assert.deepEqual(
        view.data.rows.map(({ index }) => index),
        expectedIndices,
      );
      assert.deepEqual(
        view.data.rows.map(({ values }) => values),
        expectedIndices.map((value) => ({ value })),
      );
    };
    check(read(source, request));
    const empty = read(source, { ...request, offset: total + 1 });
    assert.equal(empty.totalRows, total);
    assert.deepEqual(empty.data.rows, []);
    const tail = read(source, { ...request, offset: total - 2 });
    assert.equal(tail.totalRows, total);
    assert.deepEqual(
      tail.data.rows.map(({ index }) => index),
      [last - 1, last],
    );
    for (let i = 0; i < 50; i++) read(source, request);
    const times = [];
    const heapIncreases = [];
    for (let batch = 0; batch < batches; batch++) {
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      const view = read(source, request);
      heapIncreases.push(process.memoryUsage().heapUsed - before);
      check(view);
      const start = performance.now();
      for (let i = 0; i < iterations; i++) read(source, request);
      times.push((performance.now() - start) / iterations);
    }
    results.push({
      rowCount,
      mode,
      matchedRows: total,
      pageSize,
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
        "Synthetic fixed tables; 60 and 360 rows plus 10,000-row stress; date-filtered 10-row page; no I/O or models. Heap delta is transient growth for one read after GC.",
      results,
    },
    null,
    2,
  ),
);
