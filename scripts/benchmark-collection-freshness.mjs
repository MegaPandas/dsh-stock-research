import assert from "node:assert/strict";
import console from "node:console";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const { CollectionService, SqliteCache } = await import(core);
const DAY_MS = 86_400_000;
const samples = 7;
const iterations = 50;
const scope = {
  security: {
    id: "CN:600519",
    market: "CN",
    symbol: "600519.SH",
    exchange: "SH",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2026-10-30",
  cutoff: "2026-10-30T23:59:59.999Z",
};
const assets = ["gold", "dxy", "usdcny", "usdcnh", "eurusd", "usdjpy"];
const cases = [
  { name: "one day", asOf: "2026-10-29T23:59:59.999Z", weekdays: 1 },
  { name: "one month", asOf: "2026-09-30T23:59:59.999Z", weekdays: 22 },
  { name: "ten years", asOf: "2016-10-30T23:59:59.999Z", weekdays: 2610 },
];

function snapshot(asOf) {
  return {
    schemaVersion: 1,
    scope: structuredClone(scope),
    failures: [],
    packets: assets.map((asset) => {
      const id = `benchmark.${asset}.daily`;
      return {
        id,
        envelope: {
          dataset: "market",
          data: {
            table: id,
            title: "Synthetic global daily prices",
            interval: "1d",
            attributes: { calendar: "global_weekdays_utc" },
            columns: {},
            rows: [],
          },
          source: {
            provider: "fixture",
            url: "https://example.com/benchmark",
            adapterVersion: "fixture",
            normalizationVersion: "fixture",
          },
          asOf,
          availableAt: null,
          retrievedAt: scope.cutoff,
          cutoff: scope.cutoff,
          ageMs: Date.parse(scope.cutoff) - Date.parse(asOf),
          stale: false,
          historicalKnowledge: "unverified",
          gaps: [],
        },
      };
    }),
  };
}

const cache = new SqliteCache({ path: ":memory:", maxEntries: 1 });
const collection = new CollectionService(() => [], cache, {
  enabledSources: [],
  freshness: { market: 0, fundamentals: 0, macro: 0 },
  ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
});
const results = [];
try {
  for (const item of cases) {
    const input = snapshot(item.asOf);
    collection.finalizeScope(input, scope);
    for (const { envelope } of input.packets) {
      assert.equal(envelope.cutoff, scope.cutoff);
      assert.equal(
        envelope.ageMs,
        Date.parse(scope.cutoff) - Date.parse(item.asOf),
      );
      assert.equal(envelope.stale, true);
      assert.ok(
        envelope.gaps[0].detail.includes(
          `${item.weekdays * DAY_MS} ms against 0 ms`,
        ),
      );
    }
    for (let i = 0; i < 10; i++) collection.finalizeScope(input, scope);
    const timings = [];
    for (let sample = 0; sample < samples; sample++) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++)
        collection.finalizeScope(input, scope);
      timings.push((performance.now() - start) / iterations);
    }
    timings.sort((a, b) => a - b);
    assert.ok(
      input.packets.every(({ envelope }) => envelope.gaps.length === 1),
    );
    results.push({
      ...item,
      tables: input.packets.length,
      medianMsPerSnapshot: timings[Math.floor(samples / 2)],
      p95MsPerSnapshot: timings[Math.ceil(samples * 0.95) - 1],
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        workload: "six synthetic global daily tables; no source requests",
        samples,
        iterationsPerSample: iterations,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await collection.close();
  } finally {
    cache.close();
  }
}
