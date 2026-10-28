import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { DataRoot, RunStore } from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-runs-bench-"));
const entries = 100;
const payload = "x".repeat(1024);
let root;
try {
  root = new DataRoot(directory);
  const store = new RunStore(root);
  const run = store.create(
    { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
    () => ({ count: 0 }),
  );
  const writes = [];
  const refs = [];
  for (let i = 0; i < entries; i++) {
    const start = performance.now();
    store.commit(run.runId, (current, writer) => {
      refs.push(writer.evidence((id) => ({ id, payload })));
      return { count: current.count + 1 };
    });
    writes.push(performance.now() - start);
  }
  const readStart = performance.now();
  for (const ref of refs) store.readContent(run.runId, ref);
  const readMs = (performance.now() - readStart) / entries;
  writes.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        entries,
        payloadBytes: Buffer.byteLength(payload),
        medianCommitMs: writes[Math.floor(entries / 2)],
        p95CommitMs: writes[Math.ceil(entries * 0.95) - 1],
        averageRegisteredReadMs: readMs,
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
