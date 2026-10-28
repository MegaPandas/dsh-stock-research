import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  DataRoot,
  DecisionService,
  RunService,
  RunStore,
} from "dsh-stock-research/core";
import { openDecisionSample } from "./decision-sample.mjs";

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
  const runs = new RunService(
    new RunStore(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  let assembled = 0;
  const decisions = new DecisionService(runs, () => {
    assembled++;
    return "2024-01-04T00:00:00.000Z";
  });
  const fresh = [];
  const repeated = [];
  let sample;
  let committed;
  for (let index = 0; index < 20; index++) {
    sample = openDecisionSample(runs, `sample-${index}`);
    const start = performance.now();
    committed = decisions.decide(sample.operation, sample.taskId, "decide");
    fresh.push(performance.now() - start);
    assert.equal(runs.view(sample.operation).status, "completed");
    assert.equal(committed.refs.length, 2);
  }
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const result = decisions.decide(sample.operation, sample.taskId, "decide");
    repeated.push(performance.now() - start);
    assert.deepEqual(result, committed);
  }
  assert.equal(assembled, 20);
  const decision = runs.readArtifact(committed.refs[0]).content;
  const report = runs.readArtifact(committed.refs[1]).content;
  assert.equal(decision.payload.rating, "buy");
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
        replaySamples: 30,
        replay: stats(repeated),
        assembled,
        decisionBytes: Buffer.byteLength(JSON.stringify(decision)),
        reportBytes: Buffer.byteLength(JSON.stringify(report)),
        includes:
          "claim, fixed reads, business rules, latest required field, paired atomic publication and projections; replay repairs projections",
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
