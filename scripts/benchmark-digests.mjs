import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { openDigestSample, sampleDigestReply } from "./digest-sample.mjs";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const {
  ArtifactService,
  DataRoot,
  DigestService,
  NumberService,
  createRunService,
  RunStore,
} = await import(core);

async function measure(action) {
  const read = fs.readFileSync;
  const reads = { manifest: 0, evidence: 0, artifact: 0 };
  fs.readFileSync = function (path, ...args) {
    const result = read.call(this, path, ...args);
    const filename = String(path);
    if (filename.endsWith("/manifest.json")) reads.manifest++;
    else if (/\/evidence\/.*\.json$/.test(filename)) reads.evidence++;
    else if (/\/artifacts\/.*\.json$/.test(filename)) reads.artifact++;
    return result;
  };
  const start = performance.now();
  try {
    return { result: await action(), ms: performance.now() - start, reads };
  } finally {
    fs.readFileSync = read;
  }
}

const directory = mkdtempSync(join(tmpdir(), "dsh-digest-bench-"));
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
let root;
try {
  root = new DataRoot(directory);
  const runs = createRunService(
    new RunStore(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  let modelCalls = 0;
  let contextBytes = 0;
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  const digests = new DigestService(runs, artifacts, async (input) => {
    modelCalls++;
    contextBytes = Buffer.byteLength(JSON.stringify(input));
    return sampleDigestReply(input);
  });
  const measurements = [];
  for (const claims of [1, 100]) {
    const fresh = [];
    const repeated = [];
    let sample;
    let committed;
    let freshReads;
    let replayReads;
    for (let index = 0; index < 10; index++) {
      sample = openDigestSample(
        runs,
        artifacts,
        `sample-${claims}-${index}`,
        claims,
      );
      const measured = await measure(() =>
        digests.makeDigest(sample.operation, sample.taskId, "digest"),
      );
      committed = measured.result;
      fresh.push(measured.ms);
      freshReads ??= measured.reads;
      assert.deepEqual(measured.reads, freshReads);
      const content = runs.readArtifact(committed.refs[0]).content;
      assert.equal(content.payload.numbers.length, claims);
      assert.equal(content.payload.gaps.length, 1);
      assert.equal(content.claims.length, 0);
    }
    for (let index = 0; index < 30; index++) {
      const measured = await measure(() =>
        digests.makeDigest(sample.operation, sample.taskId, "digest"),
      );
      repeated.push(measured.ms);
      replayReads ??= measured.reads;
      assert.deepEqual(measured.reads, replayReads);
      assert.deepEqual(measured.result, committed);
    }
    measurements.push({
      claims,
      contextBytes,
      samples: 10,
      fresh: stats(fresh),
      freshReads,
      replaySamples: 30,
      replay: stats(repeated),
      replayReads,
      digestBytes: Buffer.byteLength(
        JSON.stringify(runs.readArtifact(committed.refs[0]).content),
      ),
    });
  }
  assert.equal(modelCalls, 20);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        fixture:
          "synthetic market, real local storage, immediate fake model reply; no source or model network",
        modelCalls,
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
    rmSync(directory, { recursive: true, force: true });
  }
}
