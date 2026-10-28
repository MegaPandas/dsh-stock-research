import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DataRoot, MemoryStore } from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-memory-bench-"));
const revisions = 100;
const payload = "x".repeat(1024);
let root;
try {
  root = new DataRoot(directory);
  const store = new MemoryStore(root, () => ({ last: null, count: 0 }));
  const writes = [];
  const refs = [];
  for (let i = 0; i < revisions; i++) {
    const start = performance.now();
    store.commit((current, writer) => {
      const ref = writer.entry(current.last, (ref) => ({ ref, payload }));
      refs.push(ref);
      return { last: ref, count: current.count + 1 };
    });
    writes.push(performance.now() - start);
  }
  const readStart = performance.now();
  for (const ref of refs) store.readEntry(ref);
  const readMs = (performance.now() - readStart) / revisions;
  writes.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        entries: 1,
        revisions,
        payloadBytes: Buffer.byteLength(payload),
        medianCommitMs: writes[Math.floor(revisions / 2)],
        p95CommitMs: writes[Math.ceil(revisions * 0.95) - 1],
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
