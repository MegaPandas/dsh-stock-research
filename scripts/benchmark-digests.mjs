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
  DigestService,
  NumberService,
  RunService,
  RunStore,
} from "dsh-stock-research/core";
import { openDigestSample, sampleDigestReply } from "./digest-sample.mjs";

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
  const runs = new RunService(
    new RunStore(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  let modelCalls = 0;
  let contextBytes = 0;
  const digests = new DigestService(
    runs,
    new ArtifactService(runs, new NumberService(runs)),
    async (input, _signal, _operation, submit) => {
      modelCalls++;
      contextBytes = Buffer.byteLength(JSON.stringify(input));
      return submit(sampleDigestReply(input));
    },
  );
  const measurements = [];
  for (const claims of [1, 100]) {
    const fresh = [];
    const repeated = [];
    let sample;
    let committed;
    for (let index = 0; index < 10; index++) {
      sample = openDigestSample(runs, `sample-${claims}-${index}`, claims);
      const start = performance.now();
      committed = await digests.makeDigest(
        sample.operation,
        sample.taskId,
        "digest",
      );
      fresh.push(performance.now() - start);
      const content = runs.readArtifact(committed.refs[0]).content;
      assert.equal(content.payload.numbers.length, claims);
      assert.equal(content.payload.gaps.length, 1);
      assert.equal(content.claims.length, 0);
    }
    for (let index = 0; index < 30; index++) {
      const start = performance.now();
      const result = await digests.makeDigest(
        sample.operation,
        sample.taskId,
        "digest",
      );
      repeated.push(performance.now() - start);
      assert.deepEqual(result, committed);
    }
    measurements.push({
      claims,
      contextBytes,
      samples: 10,
      fresh: stats(fresh),
      replaySamples: 30,
      replay: stats(repeated),
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
