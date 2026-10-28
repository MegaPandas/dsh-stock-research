import fs from "node:fs";
import process from "node:process";
import { DataRoot, RunStore } from "dsh-stock-research/core";

const root = new DataRoot(process.argv[2]);
const store = new RunStore(root);
const run = store.create(
  { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
  (_runId, writer) => ({
    label: "old",
    ref: writer.input(() => ({ value: "old input" })),
  }),
);

process.stdout.write(JSON.stringify({ runId: run.runId }), () => {
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    process.kill(process.pid, "SIGKILL");
  };
  store.commit(run.runId, (current, writer) => ({
    label: "new",
    ref: current.ref,
    evidence: writer.evidence(() => ({ value: "new evidence" })),
  }));
});
