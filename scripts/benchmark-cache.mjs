import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, statfsSync, statSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { SqliteCache } from "@megapandas/dsh-stock-research/core";

const SAMPLE_COUNT = 5;
const CAPACITY = 1_000;
const READ_OPERATIONS = 250;
const WRITE_OPERATIONS = 100;
const TTL_MS = 3_600_000;

function key(id) {
  return {
    provider: "fixture",
    securityId: `US:${id}`,
    dataset: "market",
    cutoff: "2024-01-08T22:00:00.000Z",
    parameters: { interval: "1d", adjustment: "unadjusted", currency: "USD" },
    adapterVersion: "1",
    normalizationVersion: "1",
  };
}

function sample(operation, operations) {
  const durations = [];
  for (let run = 0; run < SAMPLE_COUNT; run++) {
    const started = performance.now();
    for (let index = 0; index < operations; index++) operation(index, run);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const medianBatchMs = durations[Math.floor(SAMPLE_COUNT / 2)];
  return {
    operationsPerSample: operations,
    medianBatchMs: Number(medianBatchMs.toFixed(3)),
    medianUsPerOperation: Number(
      ((medianBatchMs * 1_000) / operations).toFixed(3),
    ),
  };
}

function measure(dataBytes) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-cache-benchmark-"));
  const path = join(directory, "cache.sqlite");
  const envelope = {
    dataset: "market",
    data: { sample: "x".repeat(dataBytes) },
    source: {
      provider: "fixture",
      url: "https://example.invalid/market.json",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: "2024-01-08T21:00:00.000Z",
    availableAt: "2024-01-08T21:00:00.000Z",
    retrievedAt: "2024-01-08T22:00:00.000Z",
    cutoff: "2024-01-08T22:00:00.000Z",
    ageMs: 3_600_000,
    stale: false,
    historicalKnowledge: "verified",
    gaps: [],
  };
  const cache = new SqliteCache({ path, maxEntries: CAPACITY });
  try {
    for (let index = 0; index < CAPACITY; index++)
      cache.set(key(index), envelope, TTL_MS);
    const hit = sample((index) => cache.get(key(index)), READ_OPERATIONS);
    const miss = sample(
      (index) => cache.get(key(`missing-${index}`)),
      READ_OPERATIONS,
    );
    const overwrite = sample(
      (index) => cache.set(key(index), envelope, TTL_MS),
      WRITE_OPERATIONS,
    );
    const insertAndEvict = sample(
      (index, run) => cache.set(key(`new-${run}-${index}`), envelope, TTL_MS),
      WRITE_OPERATIONS,
    );
    cache.close();
    return {
      capacity: CAPACITY,
      directory: tmpdir(),
      filesystemType: `0x${statfsSync(directory).type.toString(16)}`,
      dataBytes,
      envelopeBytes: Buffer.byteLength(JSON.stringify(envelope)),
      databaseBytes: statSync(path).size,
      hit,
      miss,
      overwrite,
      insertAndEvict,
    };
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0].model,
      storage:
        "temporary directory, file-backed SQLite with default durability",
      samples: SAMPLE_COUNT,
      measurements: [measure(1_024), measure(16_384)],
    },
    null,
    2,
  )}\n`,
);
