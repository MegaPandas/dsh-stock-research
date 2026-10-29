import fs from "node:fs";
import process from "node:process";
import { DataRoot, RunStore } from "@megapandas/dsh-stock-research/core";

const root = new DataRoot(process.argv[2]);
const store = new RunStore(root);
const key = "request-a";
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (String(args[1]).endsWith("/manifest.json")) {
    if (process.argv[3] === "after") rename(...args);
    process.kill(process.pid, "SIGKILL");
  }
  return rename(...args);
};
store.create(
  { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
  () => ({ key }),
  key,
);
