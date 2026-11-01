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
import { openDecisionSample } from "./decision-sample.mjs";

const core =
  process.argv[2] === undefined
    ? "@megapandas/dsh-stock-research/core"
    : pathToFileURL(resolve(process.argv[2])).href;
const {
  ArtifactService,
  DataRoot,
  DecisionService,
  NumberService,
  createRunService,
  RunStore,
} = await import(core);

function measure(action) {
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
    return { result: action(), ms: performance.now() - start, reads };
  } finally {
    fs.readFileSync = read;
  }
}

const directory = mkdtempSync(join(tmpdir(), "dsh-decision-bench-"));
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
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  let assembled = 0;
  const decisions = new DecisionService(runs, () => {
    assembled++;
    return "2024-01-04T00:00:00.000Z";
  });
  const fresh = [];
  const repeated = [];
  let sample;
  let committed;
  let freshReads;
  let replayReads;
  for (let index = 0; index < 20; index++) {
    sample = openDecisionSample(runs, artifacts, `sample-${index}`);
    const measured = measure(() =>
      decisions.decide(sample.operation, sample.taskId, "decide"),
    );
    committed = measured.result;
    fresh.push(measured.ms);
    freshReads ??= measured.reads;
    assert.deepEqual(measured.reads, freshReads);
    assert.equal(runs.view(sample.operation).status, "completed");
    assert.equal(committed.refs.length, 2);
  }
  for (let index = 0; index < 30; index++) {
    const measured = measure(() =>
      decisions.decide(sample.operation, sample.taskId, "decide"),
    );
    repeated.push(measured.ms);
    replayReads ??= measured.reads;
    assert.deepEqual(measured.reads, replayReads);
    assert.deepEqual(measured.result, committed);
  }
  assert.equal(assembled, 20);
  const decision = runs.readArtifact(committed.refs[0]).content;
  const report = runs.readArtifact(committed.refs[1]).content;
  assert.equal(decision.kind, "decision");
  assert.equal(report.kind, "report");
  assert.equal(decision.payload.rating, "buy");
  assert.deepEqual(report.payload.decision, decision.payload);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        fixture:
          "3 tasks; synthetic known-by market; one base and one estimate; no source/model calls",
        samples: 20,
        fresh: stats(fresh),
        freshReads,
        replaySamples: 30,
        replay: stats(repeated),
        replayReads,
        assembled,
        decisionBytes: Buffer.byteLength(JSON.stringify(decision)),
        reportBytes: Buffer.byteLength(JSON.stringify(report)),
        includes:
          "claim, fixed reads, accepted draft metadata, gap summary, paired atomic publication and projections; replay repairs projections",
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
