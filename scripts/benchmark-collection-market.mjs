import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const baselinePath = process.argv[2];
if (baselinePath === undefined)
  throw new Error(
    "Usage: benchmark-collection-market.mjs <baseline-core.mjs> [candidate-core.mjs]",
  );
const paths = [baselinePath, process.argv[3] ?? "dist/core.mjs"];
const modules = await Promise.all(
  paths.map((path) => import(pathToFileURL(resolve(path)).href)),
);
const iterations = 500;
const batches = 9;
const warmup = 100;
const scope = {
  security: {
    id: "CN:002594.SZ",
    market: "CN",
    symbol: "002594.SZ",
    exchange: "SZ",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2026-10-27",
  cutoff: "2026-10-27T10:00:00.000Z",
};

function runner(core, text) {
  const http = new core.HttpClient({
    timeoutMs: 10_000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  let requests = 0;
  http.forSource = () => http;
  http.getText = async () => {
    requests++;
    return text;
  };
  const tasks = core.createCollectionTaskFactory(
    http,
    () => {
      throw new Error("The China market task must read its own source.");
    },
    { secCiks: {} },
  )(scope, {
    enabledSources: ["tencent"],
    freshness: {
      market: 86_400_000,
      fundamentals: 86_400_000,
      macro: 86_400_000,
    },
  });
  const task = tasks.find(
    ({ id, provider }) => id === "market.daily" && provider === "tencent",
  );
  assert.ok(task);
  return {
    run: () => task.run(),
    calls: () => requests,
    close: () => http.close(),
  };
}

function stableResult(envelope) {
  const result = structuredClone(envelope);
  delete result.retrievedAt;
  return result;
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0].model,
    baseline: resolve(paths[0]),
    candidate: resolve(paths[1]),
    iterations,
    batches,
    warmup,
    network: false,
  }),
);
for (const inputRows of [60, 180, 720]) {
  const rows = Array.from({ length: inputRows }, (_, index) => [
    new Date(
      Date.parse("2026-10-26T00:00:00Z") - (inputRows - index - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10),
    "80",
    "82",
    "83",
    "79",
    "123",
  ]);
  const text = JSON.stringify({ code: 0, data: { sz002594: { day: rows } } });
  const runners = modules.map((core) => runner(core, text));
  try {
    const results = await Promise.all(runners.map((entry) => entry.run()));
    assert.deepEqual(stableResult(results[0]), stableResult(results[1]));
    for (const result of results) {
      assert.equal(result.data.rows.length, 60);
      assert.equal(result.data.rows.at(-1).values.volume, 12300);
      assert.equal(result.data.columns.volume.unit, "shares");
      for (const row of result.data.rows)
        for (const field of [
          "amount",
          "amplitude",
          "changePercent",
          "change",
          "turnover",
        ])
          assert.equal(row.values[field], null);
    }
    for (let index = 0; index < warmup; index++)
      for (const entry of runners) await entry.run();
    const before = runners.map((entry) => entry.calls());
    const samples = [[], []];
    for (let batch = 0; batch < batches; batch++) {
      for (const index of batch % 2 === 0 ? [0, 1] : [1, 0]) {
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++)
          await runners[index].run();
        samples[index].push((performance.now() - start) / iterations);
      }
    }
    const sourceCallsPerRun = runners.map(
      (entry, index) =>
        (entry.calls() - before[index]) / (iterations * batches),
    );
    assert.deepEqual(sourceCallsPerRun, [1, 1]);
    const [baseline, candidate] = samples.map(summary);
    console.log(
      JSON.stringify({
        inputRows,
        scenario: inputRows === 720 ? "oversized response" : "requested window",
        outputRows: 60,
        payloadBytes: Buffer.byteLength(text),
        sourceCallsPerRun,
        baseline,
        candidate,
        speedup: baseline.medianMs / candidate.medianMs,
      }),
    );
  } finally {
    await Promise.all(runners.map((entry) => entry.close()));
  }
}
