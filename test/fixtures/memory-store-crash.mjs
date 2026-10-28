import fs from "node:fs";
import process from "node:process";
import { DataRoot, MemoryStore } from "@megapandas/dsh-stock-research/core";

const root = new DataRoot(process.argv[2]);
const store = new MemoryStore(root, () => ({ label: "initial" }));
const first = store.commit((_current, writer) => ({
  label: "old",
  ref: writer.entry(null, () => ({ value: "old" })),
}));
process.stdout.write(JSON.stringify(first.ref), () => {
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    if (String(args[1]).endsWith("/memory/index.json"))
      process.kill(process.pid, "SIGKILL");
  };
  store.commit((current, writer) => ({
    label: "new",
    receipt: "committed",
    ref: writer.entry(current.ref, () => ({ value: "new" })),
  }));
});
