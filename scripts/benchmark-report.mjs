import { Buffer } from "node:buffer";
import console from "node:console";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { renderArtifact } from "dsh-stock-research/core";

const source = {
  runId: "sample-run",
  evidenceId: "sample-evidence",
  selector: "/value",
};
const claims = Array.from({ length: 100 }, (_, i) => ({
  id: `claim-${i}`,
  kind: "observed",
  value: i + 1,
  unit: "USD/share",
  source,
}));
const artifact = {
  kind: "analysis",
  title: "Fixed rendering benchmark",
  body: claims.map(({ id }) => `- ${id}: {{number:${id}}}`).join("\n"),
  inputRefs: [],
  claims,
  payload: {},
};
const iterations = 1_000;
const batches = 5;
for (let i = 0; i < 100; i++) renderArtifact(artifact);
const results = [];
for (let batch = 0; batch < batches; batch++) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) renderArtifact(artifact);
  results.push((performance.now() - start) / iterations);
}
results.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      claims: claims.length,
      tokens: claims.length,
      outputBytes: Buffer.byteLength(renderArtifact(artifact)),
      warmup: 100,
      batches,
      iterationsPerBatch: iterations,
      minimumBatchAverageMs: results[0],
      medianBatchAverageMs: results[Math.floor(batches / 2)],
      maximumBatchAverageMs: results.at(-1),
    },
    null,
    2,
  ),
);
